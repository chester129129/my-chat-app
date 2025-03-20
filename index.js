const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
const path = require('path');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Supabase 클라이언트 설정
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

const upload = multer({ storage: multer.memoryStorage() }); // 메모리에 파일 임시 저장

// 로그인
app.post('/login', async (req, res) => {
  const { password, userId } = req.body;
  if (!userId) return res.status(400).json({ success: false, message: 'userId 필요 / Necesitas un userId' });
  if (password === process.env.PASSWORD) {
    const { data: user } = await supabase.from('users').select('*').eq('userId', userId).single();
    if (!user) {
      await supabase.from('users').insert({ userId, friends: [], online: true, profilePic: '/uploads/default-profile.png' });
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
  const { error } = await supabase.from('users').update({ online: false }).eq('userId', userId);
  if (error) return res.status(500).json({ success: false });
  res.json({ success: true });
});

// 접속 중인 사용자 목록
app.get('/users', async (req, res) => {
  const { data, error } = await supabase.from('users').select('userId, profilePic').eq('online', true);
  if (error) return res.status(500).json([]);
  res.json(data.map(u => ({ userId: u.userId, profilePic: u.profilePic || '/uploads/default-profile.png' })));
});

// 모든 사용자 정보 가져오기
app.get('/all-users', async (req, res) => {
  const { data, error } = await supabase.from('users').select('userId, profilePic');
  if (error) return res.status(500).json([]);
  res.json(data.map(u => ({ userId: u.userId, profilePic: u.profilePic || '/uploads/default-profile.png' })));
});

// 친구 추가
app.post('/friends', async (req, res) => {
  const { userId, friendId } = req.body;
  if (!userId || !friendId) return res.status(400).json({ success: false });
  const { data: user } = await supabase.from('users').select('friends').eq('userId', userId).single();
  if (!user) {
    await supabase.from('users').insert({ userId, friends: [friendId], online: true, profilePic: '/uploads/default-profile.png' });
    res.json({ success: true, friendId });
  } else if (!user.friends.includes(friendId)) {
    const { error } = await supabase.from('users').update({ friends: [...user.friends, friendId] }).eq('userId', userId);
    if (error) return res.status(500).json({ success: false });
    res.json({ success: true, friendId });
  } else {
    res.json({ success: false, message: '이미 친구임 / Ya es amigo' });
  }
});

// 친구 삭제
app.delete('/friends', async (req, res) => {
  const { userId, friendId } = req.body;
  const { data: user } = await supabase.from('users').select('friends').eq('userId', userId).single();
  const updatedFriends = user.friends.filter(f => f !== friendId);
  const { error } = await supabase.from('users').update({ friends: updatedFriends }).eq('userId', userId);
  if (error) return res.status(500).json({ success: false });
  res.json({ success: true, friendId });
});

// 친구 목록 가져오기
app.get('/friends/:userId', async (req, res) => {
  const userId = req.params.userId;
  const { data: user, error } = await supabase.from('users').select('friends').eq('userId', userId).single();
  if (error || !user) return res.json([]);
  res.json(user.friends || []);
});

// 채팅방 목록 가져오기
app.get('/rooms/:userId', async (req, res) => {
  const userId = req.params.userId;
  const { data: messages, error } = await supabase.from('messages').select('*').ilike('room', `*${userId}*`).order('timestamp', { ascending: false });
  if (error) return res.status(500).json([]);
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
  const { data, error } = await supabase.from('messages').select('*').eq('room', 'all-chat').order('timestamp', { ascending: true });
  if (error) return res.status(500).json([]);
  res.json(data);
});

// 채팅 기록 가져오기 (삭제된 메시지 제외)
app.get('/chat/:roomId/:userId', async (req, res) => {
  const roomId = req.params.roomId;
  const userId = req.params.userId;
  const { data: messages, error: msgError } = await supabase.from('messages').select('*').eq('room', roomId).order('timestamp', { ascending: true });
  if (msgError) return res.status(500).json([]);
  const { data: deleted, error: delError } = await supabase.from('deleted_messages').select('messageId').eq('userId', userId).eq('roomId', roomId);
  if (delError) return res.status(500).json([]);
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
    translatedKr = '번역 실패 / Traducción fallida';
    translatedEs = 'Error en la traducción';
  }

  const fullMessage = `🇰🇷 ${translatedKr}\n🇪🇸 ${translatedEs}`;
  const messageData = { room: roomId, from, message: fullMessage, type: 'text', timestamp: new Date(), read: false };
  const { data, error } = await supabase.from('messages').insert(messageData).select().single();
  if (error) return res.status(500).json({ success: false });
  res.json({ success: true, message: data });
});

// 파일 업로드 (이미지/비디오)
app.post('/upload', upload.single('file'), async (req, res) => {
  const { roomId, from } = req.body;
  if (!roomId || !from || !req.file) return res.status(400).json({ success: false });
  const fileName = `${Date.now()}-${req.file.originalname}`;
  const { error: uploadError } = await supabase.storage.from('uploads').upload(fileName, req.file.buffer, {
    contentType: req.file.mimetype,
  });
  if (uploadError) return res.status(500).json({ success: false });
  const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(fileName);
  const fileUrl = urlData.publicUrl;
  const messageData = { room: roomId, from, message: fileUrl, type: req.file.mimetype.startsWith('image') ? 'image' : 'video', timestamp: new Date(), read: false };
  const { data, error } = await supabase.from('messages').insert(messageData).select().single();
  if (error) return res.status(500).json({ success: false });
  res.json({ success: true, message: data });
});

// 프로필 사진 업로드
app.post('/upload/profile', upload.single('profile'), async (req, res) => {
  const { userId } = req.body;
  if (!userId || !req.file) return res.status(400).json({ success: false });
  const fileName = `${userId}-${Date.now()}.jpg`;
  const { error: uploadError } = await supabase.storage.from('uploads').upload(fileName, req.file.buffer, {
    contentType: req.file.mimetype,
  });
  if (uploadError) return res.status(500).json({ success: false });
  const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(fileName);
  const fileUrl = urlData.publicUrl;
  const { error } = await supabase.from('users').update({ profilePic: fileUrl }).eq('userId', userId);
  if (error) return res.status(500).json({ success: false });
  res.json({ success: true, profilePic: fileUrl });
});

// 음성 메시지 업로드
app.post('/upload/voice', upload.single('voice'), async (req, res) => {
  const { roomId, from } = req.body;
  if (!roomId || !from || !req.file) return res.status(400).json({ success: false });
  const fileName = `${Date.now()}-voice.webm`;
  const { error: uploadError } = await supabase.storage.from('uploads').upload(fileName, req.file.buffer, {
    contentType: req.file.mimetype,
  });
  if (uploadError) return res.status(500).json({ success: false });
  const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(fileName);
  const fileUrl = urlData.publicUrl;
  const messageData = { room: roomId, from, message: fileUrl, type: 'voice', timestamp: new Date(), read: false };
  const { data, error } = await supabase.from('messages').insert(messageData).select().single();
  if (error) return res.status(500).json({ success: false });
  res.json({ success: true, message: data });
});

// 채팅 기록 삭제 (개인별)
app.post('/chat/delete/:roomId/:userId', async (req, res) => {
  const roomId = req.params.roomId;
  const userId = req.params.userId;
  const { data: messages, error: msgError } = await supabase.from('messages').select('id').eq('room', roomId);
  if (msgError) return res.status(500).json({ success: false });
  const deletedEntries = messages.map(m => ({ userId, roomId, messageId: m.id }));
  const { error } = await supabase.from('deleted_messages').insert(deletedEntries);
  if (error) return res.status(500).json({ success: false });
  res.json({ success: true });
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`서버가 http://localhost:${process.env.PORT || 3000}에서 실행 중이야! / ¡El servidor está corriendo!`);
});