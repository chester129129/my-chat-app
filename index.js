const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const supabaseUrl = 'https://fpliyvgivfbfwobhiqbz.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZwbGl5dmdpdmZiZndvYmhpcWJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDI0NDc0NTAsImV4cCI6MjA1ODAyMzQ1MH0.rfVn8eOyGSBp9asl9dUBSC-nbw1JR8w02K8gJaISOi8';
const supabase = createClient(supabaseUrl, supabaseKey);

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// 로그인
app.post('/login', async (req, res) => {
  const { password, userId } = req.body;
  if (!userId) return res.status(400).json({ success: false, message: 'userId 필요' });
  if (password === process.env.PASSWORD) {
    const { data: user } = await supabase.from('users').select('*').eq('userId', userId).single();
    if (!user) {
      await supabase.from('users').insert({ userId, friends: [], online: true, profilePic: 'https://fpliyvgivfbfwobhiqbz.supabase.co/storage/v1/object/public/profile-pics/default-profile.png' });
    } else {
      await supabase.from('users').update({ online: true }).eq('userId', userId);
    }
    res.json({ success: true, userId });
  } else {
    res.status(401).json({ success: false });
  }
});

// 로그아웃
app.post('/logout', async (req, res) => {
  const { userId } = req.body;
  await supabase.from('users').update({ online: false }).eq('userId', userId);
  res.json({ success: true });
});

// 접속 중인 사용자 목록
app.get('/users', async (req, res) => {
  const { data: users } = await supabase.from('users').select('userId, profilePic').eq('online', true);
  res.json(users || []);
});

// 모든 사용자 정보 가져오기
app.get('/all-users', async (req, res) => {
  const { data: users } = await supabase.from('users').select('userId, profilePic');
  res.json(users || []);
});

// 친구 추가
app.post('/friends', async (req, res) => {
  const { userId, friendId } = req.body;
  if (!userId || !friendId) return res.status(400).json({ success: false });
  const { data: user } = await supabase.from('users').select('friends').eq('userId', userId).single();
  if (!user) {
    await supabase.from('users').insert({ userId, friends: [friendId], online: true });
    res.json({ success: true, friendId });
  } else if (!user.friends.includes(friendId)) {
    await supabase.from('users').update({ friends: [...user.friends, friendId] }).eq('userId', userId);
    res.json({ success: true, friendId });
  } else {
    res.json({ success: false, message: '이미 친구임' });
  }
});

// 친구 삭제
app.delete('/friends', async (req, res) => {
  const { userId, friendId } = req.body;
  const { data: user } = await supabase.from('users').select('friends').eq('userId', userId).single();
  if (user) {
    const newFriends = user.friends.filter(f => f !== friendId);
    await supabase.from('users').update({ friends: newFriends }).eq('userId', userId);
  }
  res.json({ success: true, friendId });
});

// 친구 목록 가져오기
app.get('/friends/:userId', async (req, res) => {
  const userId = req.params.userId;
  const { data: user } = await supabase.from('users').select('friends').eq('userId', userId).single();
  res.json(user?.friends || []);
});

// 채팅방 목록 가져오기
app.get('/rooms/:userId', async (req, res) => {
  const userId = req.params.userId;
  const { data: messages } = await supabase.from('messages').select('*').ilike('room', `*${userId}*`).order('timestamp', { ascending: false });
  const uniqueRooms = [...new Set(messages.map(m => m.room))];
  const roomData = uniqueRooms.map(roomId => {
    const lastMessage = messages.find(m => m.room === roomId);
    const unreadCount = messages.filter(m => m.room === roomId && !m.read && m.from !== userId).length;
    return { roomId, lastMessage, unreadCount };
  });
  res.json(roomData);
});

// 전체 채팅 기록 가져오기
app.get('/all-chat', async (req, res) => {
  const { data: messages } = await supabase.from('messages').select('*').eq('room', 'all-chat').order('timestamp', { ascending: true });
  res.json(messages || []);
});

// 채팅 기록 가져오기 (삭제된 메시지 제외)
app.get('/chat/:roomId/:userId', async (req, res) => {
  const roomId = req.params.roomId;
  const userId = req.params.userId;
  const { data: messages } = await supabase.from('messages').select('*').eq('room', roomId).order('timestamp', { ascending: true });
  const { data: deleted } = await supabase.from('deletedMessages').select('messageId').eq('userId', userId).eq('roomId', roomId);
  const deletedIds = deleted.map(d => d.messageId);
  const filteredMessages = messages.filter(m => !deletedIds.includes(m.id));
  await supabase.from('messages').update({ read: true }).eq('room', roomId).eq('read', false);
  res.json(filteredMessages);
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
    translatedKr = '번역 실패';
    translatedEs = 'Error en la traducción';
  }
  const fullMessage = `🇰🇷 ${translatedKr}\n🇪🇸 ${translatedEs}`;
  const messageData = { room: roomId, from, message: fullMessage, type: 'text', timestamp: new Date(), read: false };
  const { data: newDoc } = await supabase.from('messages').insert(messageData).select().single();
  res.json({ success: true, message: newDoc });
});

// 파일 업로드 (이미지/비디오)
app.post('/upload', upload.single('file'), async (req, res) => {
  const { roomId, from } = req.body;
  if (!roomId || !from || !req.file) {
    console.log('roomId, from 또는 파일 없음:', { roomId, from, file: req.file });
    return res.status(400).json({ success: false });
  }

  const fileName = `${from}-${Date.now()}.${req.file.originalname.split('.').pop()}`;
  console.log('파일 업로드 시작:', fileName);

  const { error } = await supabase.storage
    .from('profile-pics')
    .upload(fileName, req.file.buffer, {
      contentType: req.file.mimetype,
    });

  if (error) {
    console.error('업로드 에러:', error);
    return res.status(500).json({ success: false, error: error.message });
  }

  const { publicUrl } = supabase.storage.from('profile-pics').getPublicUrl(fileName);
  const fileUrl = publicUrl;
  console.log('업로드 성공, URL:', fileUrl);

  const messageData = {
    room: roomId,
    from,
    message: fileUrl,
    type: req.file.mimetype.startsWith('image') ? 'image' : 'video',
    timestamp: new Date(),
    read: false
  };
  const { data: newDoc } = await supabase.from('messages').insert(messageData).select().single();
  res.json({ success: true, message: newDoc });
});

// 프로필 사진 업로드
app.post('/upload/profile', upload.single('profile'), async (req, res) => {
  const { userId } = req.body;
  if (!userId || !req.file) {
    console.log('userId 또는 파일 없음:', { userId, file: req.file });
    return res.status(400).json({ success: false });
  }

  const fileName = `${userId}-${Date.now()}.${req.file.originalname.split('.').pop()}`;
  console.log('파일 업로드 시작:', fileName);

  const { error } = await supabase.storage
    .from('profile-pics')
    .upload(fileName, req.file.buffer, {
      contentType: req.file.mimetype,
    });

  if (error) {
    console.error('업로드 에러:', error);
    return res.status(500).json({ success: false, error: error.message });
  }

  const { publicUrl } = supabase.storage.from('profile-pics').getPublicUrl(fileName);
  const fileUrl = publicUrl;
  console.log('업로드 성공, URL:', fileUrl);

  await supabase.from('users').update({ profilePic: fileUrl }).eq('userId', userId);
  res.json({ success: true, profilePic: fileUrl });
});

// 음성 메시지 업로드
app.post('/upload/voice', upload.single('voice'), async (req, res) => {
  const { roomId, from } = req.body;
  if (!roomId || !from || !req.file) {
    console.log('roomId, from 또는 파일 없음:', { roomId, from, file: req.file });
    return res.status(400).json({ success: false });
  }

  const fileName = `${from}-${Date.now()}.webm`;
  console.log('파일 업로드 시작:', fileName);

  const { error } = await supabase.storage
    .from('profile-pics')
    .upload(fileName, req.file.buffer, {
      contentType: 'audio/webm',
    });

  if (error) {
    console.error('업로드 에러:', error);
    return res.status(500).json({ success: false, error: error.message });
  }

  const { publicUrl } = supabase.storage.from('profile-pics').getPublicUrl(fileName);
  const fileUrl = publicUrl;
  console.log('업로드 성공, URL:', fileUrl);

  const messageData = { room: roomId, from, message: fileUrl, type: 'voice', timestamp: new Date(), read: false };
  const { data: newDoc } = await supabase.from('messages').insert(messageData).select().single();
  res.json({ success: true, message: newDoc });
});

// 채팅 기록 삭제 (개인별)
app.post('/chat/delete/:roomId/:userId', async (req, res) => {
  const roomId = req.params.roomId;
  const userId = req.params.userId;
  const { data: messages } = await supabase.from('messages').select('id').eq('room', roomId);
  const deletedEntries = messages.map(m => ({ userId, roomId, messageId: m.id }));
  await supabase.from('deletedMessages').insert(deletedEntries);
  res.json({ success: true });
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`서버가 http://localhost:${process.env.PORT || 3000}에서 실행 중이야!`);
});