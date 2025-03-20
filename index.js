const express = require('express');
const Datastore = require('nedb');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const messagesDB = new Datastore({ filename: 'messages.db', autoload: true });
const usersDB = new Datastore({ filename: 'users.db', autoload: true });
const deletedMessagesDB = new Datastore({ filename: 'deletedMessages.db', autoload: true });

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

const upload = multer({ dest: 'public/uploads/' });

// 데이터베이스 크기 체크하고 오래된 메시지 삭제하는 함수
function checkAndTrimMessagesDB() {
  const MAX_SIZE = 400 * 1024 * 1024; // 400MB
  fs.stat('messages.db', (err, stats) => {
    if (err) return console.log('DB 크기 확인 오류:', err);
    if (stats.size > MAX_SIZE) {
      messagesDB.find({}).sort({ timestamp: 1 }).limit(1).exec((err, oldest) => {
        if (oldest.length > 0) {
          messagesDB.remove({ _id: oldest[0]._id }, {}, () => {
            console.log('오래된 메시지 삭제됨');
            checkAndTrimMessagesDB(); // 재귀적으로 크기 확인
          });
        }
      });
    }
  });
}

// 로그인
app.post('/login', (req, res) => {
  const { password, userId } = req.body;
  if (!userId) return res.status(400).json({ success: false, message: 'userId 필요 / Necesitas un userId' });
  if (password === process.env.PASSWORD) {
    usersDB.findOne({ userId }, (err, user) => {
      if (!user) {
        usersDB.insert({ userId, friends: [], online: true, profilePic: '/uploads/default-profile.png' });
      } else {
        usersDB.update({ userId }, { $set: { online: true } });
      }
      res.json({ success: true, userId });
    });
  } else {
    res.status(401).json({ success: false });
  }
});

// 로그아웃
app.post('/logout', (req, res) => {
  const { userId } = req.body;
  usersDB.update({ userId }, { $set: { online: false } }, {}, (err) => {
    if (err) return res.status(500).json({ success: false });
    res.json({ success: true });
  });
});

// 접속 중인 사용자 목록
app.get('/users', (req, res) => {
  usersDB.find({ online: true }, (err, users) => {
    if (err) return res.status(500).json([]);
    const validUsers = users.map(u => ({ userId: u.userId, profilePic: u.profilePic || '/uploads/default-profile.png' }));
    res.json(validUsers);
  });
});

// 모든 사용자 정보 가져오기 (프로필 사진 포함)
app.get('/all-users', (req, res) => {
  usersDB.find({}, (err, users) => {
    if (err) return res.status(500).json([]);
    const allUsers = users.map(u => ({ userId: u.userId, profilePic: u.profilePic || '/uploads/default-profile.png' }));
    res.json(allUsers);
  });
});

// 친구 추가
app.post('/friends', (req, res) => {
  const { userId, friendId } = req.body;
  if (!userId || !friendId) return res.status(400).json({ success: false });
  usersDB.findOne({ userId }, (err, user) => {
    if (!user) {
      usersDB.insert({ userId, friends: [friendId], online: true, profilePic: '/uploads/default-profile.png' });
    } else if (!user.friends.includes(friendId)) {
      usersDB.update({ userId }, { $push: { friends: friendId } }, {}, (err) => {
        res.json({ success: true, friendId });
      });
    } else {
      res.json({ success: false, message: '이미 친구임 / Ya es amigo' });
    }
  });
});

// 친구 삭제
app.delete('/friends', (req, res) => {
  const { userId, friendId } = req.body;
  usersDB.update({ userId }, { $pull: { friends: friendId } }, {}, (err) => {
    res.json({ success: true, friendId });
  });
});

// 친구 목록 가져오기
app.get('/friends/:userId', (req, res) => {
  const userId = req.params.userId;
  usersDB.findOne({ userId }, (err, user) => {
    if (err || !user) return res.json([]);
    res.json(user.friends || []);
  });
});

// 채팅방 목록 가져오기
app.get('/rooms/:userId', (req, res) => {
  const userId = req.params.userId;
  messagesDB.find({ room: { $regex: new RegExp(userId) } }).sort({ timestamp: -1 }).exec((err, messages) => {
    if (err) return res.status(500).json([]);
    const uniqueRooms = [...new Set(messages.map(m => m.room))];
    const roomData = uniqueRooms.map(roomId => {
      const lastMessage = messages.find(m => m.room === roomId);
      const unreadCount = messages.filter(m => m.room === roomId && !m.read && m.from !== userId).length;
      return { roomId, lastMessage, unreadCount };
    });
    res.json(roomData);
  });
});

// 전체 채팅 기록 가져오기
app.get('/all-chat', (req, res) => {
  const roomId = 'all-chat';
  messagesDB.find({ room: roomId }).sort({ timestamp: 1 }).exec((err, messages) => {
    if (err) return res.status(500).json([]);
    res.json(messages);
  });
});

// 채팅 기록 가져오기 (삭제된 메시지 제외)
app.get('/chat/:roomId/:userId', (req, res) => {
  const roomId = req.params.roomId;
  const userId = req.params.userId;
  messagesDB.find({ room: roomId }).sort({ timestamp: 1 }).exec((err, messages) => {
    if (err) return res.status(500).json([]);
    deletedMessagesDB.find({ userId, roomId }, (err, deleted) => {
      const deletedIds = deleted.map(d => d.messageId);
      const filteredMessages = messages.filter(m => !deletedIds.includes(m._id));
      messagesDB.update({ room: roomId, read: false }, { $set: { read: true } }, { multi: true });
      res.json(filteredMessages);
    });
  });
});

// 텍스트 메시지 보내기
app.post('/chat', async (req, res) => {
  const { roomId, from, message } = req.body;
  if (!roomId || !from || !message) return res.status(400).json({ success: false });
  let translatedKr, translatedEs;

  try {
    const result = await model.generateContent(`너는 한국어와 유럽 스페인어 전문가야. "${message}"를 자연스럽게 번역해줘. 결과는 "한국어: [번역]\n스페인어: [번역]" 형식으로, 부가 설명 없이 두 문장만 써줘.`);
    const lines = result.response.text().split('\n');
    translatedKr = lines[0].replace('한국어: ', '').trim();
    translatedEs = lines[1] ? lines[1].replace('스페인어: ', '').trim() : 'Error en la traducción';
  } catch (error) {
    translatedKr = '번역 실패 / Traducción fallida';
    translatedEs = 'Error en la traducción';
  }

  const fullMessage = `🇰🇷 ${translatedKr}\n🇪🇸 ${translatedEs}`;
  const messageData = { room: roomId, from, message: fullMessage, type: 'text', timestamp: new Date(), read: false };
  messagesDB.insert(messageData, (err, newDoc) => {
    if (err) return res.status(500).json({ success: false });
    checkAndTrimMessagesDB(); // 크기 체크
    res.json({ success: true, message: newDoc });
  });
});

// 파일 업로드 (이미지/비디오)
app.post('/upload', upload.single('file'), (req, res) => {
  const { roomId, from } = req.body;
  if (!roomId || !from || !req.file) return res.status(400).json({ success: false });
  const fileUrl = `/uploads/${req.file.filename}`;
  const messageData = {
    room: roomId,
    from,
    message: fileUrl,
    type: req.file.mimetype.startsWith('image') ? 'image' : 'video',
    timestamp: new Date(),
    read: false
  };
  messagesDB.insert(messageData, (err, newDoc) => {
    if (err) return res.status(500).json({ success: false });
    checkAndTrimMessagesDB(); // 크기 체크
    res.json({ success: true, message: newDoc });
  });
});

// 프로필 사진 업로드
app.post('/upload/profile', upload.single('profile'), (req, res) => {
  const { userId } = req.body;
  if (!userId || !req.file) return res.status(400).json({ success: false });
  const fileUrl = `/uploads/${req.file.filename}`;
  usersDB.update({ userId }, { $set: { profilePic: fileUrl } }, {}, (err) => {
    if (err) return res.status(500).json({ success: false });
    res.json({ success: true, profilePic: fileUrl });
  });
});

// 음성 메시지 업로드
app.post('/upload/voice', upload.single('voice'), (req, res) => {
  const { roomId, from } = req.body;
  if (!roomId || !from || !req.file) return res.status(400).json({ success: false });
  const fileUrl = `/uploads/${req.file.filename}`;
  const messageData = { room: roomId, from, message: fileUrl, type: 'voice', timestamp: new Date(), read: false };
  messagesDB.insert(messageData, (err, newDoc) => {
    if (err) return res.status(500).json({ success: false });
    checkAndTrimMessagesDB(); // 크기 체크
    res.json({ success: true, message: newDoc });
  });
});

// 채팅 기록 삭제 (개인별)
app.post('/chat/delete/:roomId/:userId', (req, res) => {
  const roomId = req.params.roomId;
  const userId = req.params.userId;
  messagesDB.find({ room: roomId }, (err, messages) => {
    if (err) return res.status(500).json({ success: false });
    const deletedEntries = messages.map(m => ({ userId, roomId, messageId: m._id }));
    deletedMessagesDB.insert(deletedEntries, (err) => {
      if (err) return res.status(500).json({ success: false });
      res.json({ success: true });
    });
  });
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`서버가 http://localhost:${process.env.PORT || 3000}에서 실행 중이야! / ¡El servidor está corriendo!`);
});