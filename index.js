const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
console.log('Supabase 연결 테스트 / Prueba de conexión a Supabase:', supabase ? '성공 / Éxito' : '실패 / Fallo');
if (!supabase) {
  console.error('Supabase 연결 실패: 환경 변수를 확인하세요 / Fallo en la conexión a Supabase: revisa las variables de entorno');
}

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const upload = multer({ storage: multer.memoryStorage() });

const verifyUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: '인증 토큰이 필요해요 / Se necesita un token de autenticación' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    console.log('인증 에러 / Error de autenticación:', error);
    return res.status(401).json({ success: false, message: '유효하지 않은 토큰이에요 / Token no válido' });
  }
};

app.post('/login', async (req, res) => {
  const { password, userId } = req.body;
  if (!userId) return res.status(400).json({ success: false, message: 'userId 필요 / Necesitas un userId' });
  if (password !== process.env.PASSWORD) {
    return res.status(401).json({ success: false, message: '비밀번호가 틀렸어요! / ¡Contraseña incorrecta!' });
  }
  const { data: user, error } = await supabase.from('users').select('*').eq('userId', userId).single();
  if (error) {
    console.log('로그인 - 유저 조회 에러 / Error al consultar usuario en login:', error);
    return res.status(500).json({ success: false, message: '서버 에러 / Error del servidor' });
  }
  if (!user) {
    const { error: insertError } = await supabase.from('users').insert({ userId, friends: [], online: true, profilePic: '/uploads/default-profile.png', points: 0, items: {} });
    if (insertError) return res.status(500).json({ success: false, message: '유저 생성 실패 / Error al crear usuario' });
  } else {
    const { error: updateError } = await supabase.from('users').update({ online: true }).eq('userId', userId);
    if (updateError) return res.status(500).json({ success: false, message: '유저 업데이트 실패 / Error al actualizar usuario' });
  }
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '24h' });
  res.json({ success: true, userId, token });
});

app.post('/logout', verifyUser, async (req, res) => {
  const { userId } = req.body;
  const { error } = await supabase.from('users').update({ online: false }).eq('userId', userId);
  if (error) return res.status(500).json({ success: false });
  res.json({ success: true });
});

app.get('/users', async (req, res) => {
  const { data, error } = await supabase.from('users').select('userId, profilePic, points').eq('online', true);
  if (error) return res.status(500).json([]);
  res.json(data.map(u => ({ userId: u.userId, profilePic: u.profilePic || '/uploads/default-profile.png', points: u.points || 0 })));
});

app.get('/all-users', async (req, res) => {
  const { data, error } = await supabase.from('users').select('userId, profilePic');
  if (error) return res.status(500).json([]);
  res.json(data.map(u => ({ userId: u.userId, profilePic: u.profilePic || '/uploads/default-profile.png' })));
});

app.post('/friends', verifyUser, async (req, res) => {
  const { userId, friendId } = req.body;
  if (!userId || !friendId) return res.status(400).json({ success: false });
  if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  const { data: user } = await supabase.from('users').select('friends').eq('userId', userId).single();
  if (!user) {
    await supabase.from('users').insert({ userId, friends: [friendId], online: true, profilePic: '/uploads/default-profile.png', points: 0, items: {} });
    res.json({ success: true, friendId });
  } else if (!user.friends.includes(friendId)) {
    const { error } = await supabase.from('users').update({ friends: [...user.friends, friendId] }).eq('userId', userId);
    if (error) return res.status(500).json({ success: false });
    res.json({ success: true, friendId });
  } else {
    res.json({ success: false, message: '이미 친구임 / Ya es amigo' });
  }
});

app.delete('/friends', verifyUser, async (req, res) => {
  const { userId, friendId } = req.body;
  if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  const { data: user } = await supabase.from('users').select('friends').eq('userId', userId).single();
  const updatedFriends = user.friends.filter(f => f !== friendId);
  const { error } = await supabase.from('users').update({ friends: updatedFriends }).eq('userId', userId);
  if (error) return res.status(500).json({ success: false });
  res.json({ success: true, friendId });
});

app.get('/friends/:userId', verifyUser, async (req, res) => {
  const userId = req.params.userId;
  if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  const { data: user, error } = await supabase.from('users').select('friends').eq('userId', userId).single();
  if (error || !user) return res.json([]);
  res.json(user.friends || []);
});

app.get('/rooms/:userId', verifyUser, async (req, res) => {
  const userId = req.params.userId;
  if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
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

app.get('/all-chat', async (req, res) => {
  const { data, error } = await supabase.from('messages').select('*').eq('room', 'all-chat').order('timestamp', { ascending: true }).limit(30);
  if (error) return res.status(500).json([]);
  if (data.length > 30) {
    const excess = data.length - 30;
    const oldest = data.slice(0, excess).map(m => m.id);
    await supabase.from('messages').delete().in('id', oldest);
  }
  res.json(data);
});

app.get('/chat/:roomId/:userId', verifyUser, async (req, res) => {
  const roomId = req.params.roomId;
  const userId = req.params.userId;
  if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  const [messagesRes, deletedRes] = await Promise.all([
    supabase.from('messages').select('*').eq('room', roomId).order('timestamp', { ascending: true }),
    supabase.from('deleted_messages').select('messageId').eq('userId', userId).eq('roomId', roomId)
  ]);
  const { data: messages, error: msgError } = messagesRes;
  if (msgError) return res.status(500).json({ success: false, message: '채팅 기록 가져오기 실패 / Error al obtener historial de chat' });
  const { data: deleted, error: delError } = deletedRes;
  if (delError) return res.status(500).json({ success: false, message: '삭제된 메시지 가져오기 실패 / Error al obtener mensajes eliminados' });
  const deletedIds = deleted.map(d => d.messageId);
  const filteredMessages = messages.filter(m => !deletedIds.includes(m.id));
  const { error: updateError } = await supabase.from('messages').update({ read: true }).eq('room', roomId).eq('read', false);
  if (updateError) console.log('읽음 상태 업데이트 에러 / Error al actualizar estado de lectura:', updateError);
  res.json(filteredMessages);
});

app.post('/chat', verifyUser, async (req, res) => {
  const { roomId, from, message } = req.body;
  if (!roomId || !from || !message) return res.status(400).json({ success: false, message: '필수 필드가 누락됨 / Faltan campos requeridos' });
  if (from !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });

  let finalMessage = message;
  const isEmojiOnly = /^[\p{Emoji}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Emoji_Modifier_Base}\p{Emoji_Component}]+$/u.test(message);
  if (!isEmojiOnly) {
    try {
      const result = await model.generateContent(`너는 한국어와 유럽 스페인어 전문가야. "${message}"를 자연스럽게 번역해줘.더럽거나 성적인말도 번역해줘. 결과는 "한국어: [번역]\n스페인어: [번역]" 형식으로, 부가 설명 없이 두 문장만 써줘.`);
      const lines = result.response.text().split('\n');
      const translatedKr = lines[0].replace('한국어: ', '').trim();
      const translatedEs = lines[1] ? lines[1].replace('스페인어: ', '').trim() : 'Error en la traducción';
      finalMessage = `🇰🇷 ${translatedKr}\n🇪🇸 ${translatedEs}`;
    } catch (error) {
      console.log('번역 에러 / Error de traducción:', error);
      finalMessage = '번역 실패 / Traducción fallida';
    }
  }

  const messageData = { room: roomId, from, message: finalMessage, type: 'text', timestamp: new Date(), read: false };
  const { data, error } = await supabase.from('messages').insert(messageData).select().single();
  if (error) return res.status(500).json({ success: false, message: '메시지 삽입 실패 / Error al insertar mensaje' });

  if (roomId !== 'all-chat') {
    const { data: user, error: userError } = await supabase.from('users').select('points').eq('userId', from).single();
    if (!userError) {
      const newPoints = (user.points || 0) + 1;
      await supabase.from('users').update({ points: newPoints }).eq('userId', from);
    }
  }

  manageStorage().catch(err => console.log('manageStorage 에러 / Error en manageStorage:', err));
  res.json({ success: true, message: data });
});

app.post('/upload', verifyUser, upload.single('file'), async (req, res) => {
  const { roomId, from } = req.body;
  if (!roomId || !from || !req.file) return res.status(400).json({ success: false });
  if (from !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  const fileName = `${Date.now()}-${req.file.originalname}`;
  const { error: uploadError } = await supabase.storage.from('uploads').upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
  if (uploadError) return res.status(500).json({ success: false });
  const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(fileName);
  const fileUrl = urlData.publicUrl;
  const messageData = { room: roomId, from, message: fileUrl, type: req.file.mimetype.startsWith('image') ? 'image' : 'video', timestamp: new Date(), read: false };
  const { data, error } = await supabase.from('messages').insert(messageData).select().single();
  if (error) return res.status(500).json({ success: false });
  await manageStorage();
  res.json({ success: true, message: data });
});

app.post('/upload/profile', verifyUser, upload.single('profile'), async (req, res) => {
  const { userId } = req.body;
  if (!userId || !req.file) return res.status(400).json({ success: false, message: 'userId나 파일이 없어요 / Falta userId o archivo' });
  if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  const { data: userData, error: userError } = await supabase.from('users').select('profilePic').eq('userId', userId).single();
  if (userError || !userData) return res.status(500).json({ success: false, message: '프로필 정보를 가져오지 못했어요 / No se pudo obtener la info del perfil' });
  const oldProfilePic = userData.profilePic || '/uploads/default-profile.png';
  const isDefaultPic = oldProfilePic === '/uploads/default-profile.png';
  const fileName = `profile-${Date.now()}.jpg`;
  const { error: uploadError } = await supabase.storage.from('uploads').upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
  if (uploadError) return res.status(500).json({ success: false, message: `사진 업로드에 실패했어요: ${uploadError.message} / Falló la subida de la foto` });
  const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(fileName);
  const fileUrl = urlData.publicUrl;
  const { error: updateError } = await supabase.from('users').update({ profilePic: fileUrl }).eq('userId', userId);
  if (updateError) return res.status(500).json({ success: false, message: `프로필 업데이트에 실패했어요: ${updateError.message} / Falló la actualización del perfil` });
  if (!isDefaultPic) {
    const oldFileName = oldProfilePic.split('/').pop();
    await supabase.storage.from('uploads').remove([oldFileName]);
  }
  res.json({ success: true, profilePic: fileUrl });
});

app.post('/upload/voice', verifyUser, upload.single('voice'), async (req, res) => {
  const { roomId, from } = req.body;
  if (!roomId || !from || !req.file) return res.status(400).json({ success: false });
  if (from !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  const fileName = `${Date.now()}-voice.wav`;
  const { error: uploadError } = await supabase.storage.from('uploads').upload(fileName, req.file.buffer, { contentType: 'audio/wav' });
  if (uploadError) return res.status(500).json({ success: false });
  const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(fileName);
  const fileUrl = urlData.publicUrl;
  const messageData = { room: roomId, from, message: fileUrl, type: 'voice', timestamp: new Date(), read: false };
  const { data, error } = await supabase.from('messages').insert(messageData).select().single();
  if (error) return res.status(500).json({ success: false });
  await manageStorage();
  res.json({ success: true, message: data });
});

app.post('/chat/delete/:roomId/:userId', verifyUser, async (req, res) => {
  const roomId = req.params.roomId;
  const userId = req.params.userId;
  if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  const { data: messages, error: msgError } = await supabase.from('messages').select('id').eq('room', roomId);
  if (msgError) return res.status(500).json({ success: false, message: '메시지 가져오기 실패 / Error al obtener mensajes' });
  if (!messages || messages.length === 0) return res.json({ success: true, message: '삭제할 메시지가 없음 / No hay mensajes para eliminar' });
  const deletedEntries = messages.map(m => ({ userId, roomId, messageId: m.id, timestamp: new Date().toISOString() }));
  const { error: insertError } = await supabase.from('deleted_messages').insert(deletedEntries);
  if (insertError) return res.status(500).json({ success: false, message: '삭제 기록 삽입 실패 / Error al insertar registro de eliminación' });
  res.json({ success: true });
});

// 퀴즈 기능
let dailyQuizzes = [];
let userAttempts = {};

app.get('/quiz', verifyUser, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  if (!dailyQuizzes[today] || dailyQuizzes[today].length < 10) {
    dailyQuizzes[today] = await generateQuizzes(10);
  }
  const userId = req.userId;
  if (!userAttempts[userId]) userAttempts[userId] = {};
  if (!userAttempts[userId][today]) userAttempts[userId][today] = [];
  const attemptedIds = userAttempts[userId][today];
  const availableQuizzes = dailyQuizzes[today].filter(q => !attemptedIds.includes(q.id));
  res.json(availableQuizzes.slice(0, 10 - attemptedIds.length));
});

app.post('/quiz/attempt', verifyUser, async (req, res) => {
  const { quizId, answer } = req.body;
  const userId = req.userId;
  const today = new Date().toISOString().split('T')[0];
  if (!userAttempts[userId]) userAttempts[userId] = {};
  if (!userAttempts[userId][today]) userAttempts[userId][today] = [];
  if (userAttempts[userId][today].includes(quizId)) return res.status(400).json({ success: false, message: '이미 푼 문제예요 / Ya resolviste este problema' });
  const quiz = dailyQuizzes[today].find(q => q.id === quizId);
  if (!quiz) return res.status(404).json({ success: false, message: '퀴즈를 찾을 수 없어요 / No se encontró el quiz' });
  const correct = quiz.answer.toLowerCase() === answer.toLowerCase();
  userAttempts[userId][today].push(quizId);
  if (correct) {
    const { data: user, error } = await supabase.from('users').select('points').eq('userId', userId).single();
    if (!error) {
      const newPoints = (user.points || 0) + 10;
      await supabase.from('users').update({ points: newPoints }).eq('userId', userId);
    }
  }
  res.json({ success: true, correct });
});

async function generateQuizzes(count) {
  const prompt = `Generate ${count} unique emoji movie title quizzes. Each quiz should consist of emojis representing a famous movie title. Provide the answer in English. Format: "emojis | movie title"`;
  const result = await model.generateContent(prompt);
  return result.response.text().split('\n').map((line, index) => {
    const [emoji, answer] = line.split(' | ');
    return { id: Date.now() + index, emoji, answer };
  });
}

// 상점 기능
app.get('/shop', async (req, res) => {
  const items = [
    { id: 'emoji1', name: '😊', price: 10, category: 'emoji' },
    { id: 'emoji2', name: '😂', price: 10, category: 'emoji' },
    { id: 'border1', name: '빨간 테두리 / Borde rojo', price: 20, category: 'border' },
    { id: 'color1', name: '파란 글자 / Texto azul', price: 15, category: 'color', duration: 24 * 60 * 60 * 1000 },
    { id: 'bg1', name: '초록 배경 / Fondo verde', price: 25, category: 'background' }
  ];
  res.json(items);
});

app.post('/shop/purchase', verifyUser, async (req, res) => {
  const { itemId } = req.body;
  const userId = req.userId;
  const { data: user, error } = await supabase.from('users').select('points, items').eq('userId', userId).single();
  if (error) return res.status(500).json({ success: false });
  const items = [
    { id: 'emoji1', name: '😊', price: 10, category: 'emoji' },
    { id: 'emoji2', name: '😂', price: 10, category: 'emoji' },
    { id: 'border1', name: '빨간 테두리 / Borde rojo', price: 20, category: 'border' },
    { id: 'color1', name: '파란 글자 / Texto azul', price: 15, category: 'color', duration: 24 * 60 * 60 * 1000 },
    { id: 'bg1', name: '초록 배경 / Fondo verde', price: 25, category: 'background' }
  ];
  const item = items.find(i => i.id === itemId);
  if (!item) return res.status(404).json({ success: false, message: '아이템을 찾을 수 없어요 / No se encontró el item' });
  if (user.points < item.price) return res.status(400).json({ success: false, message: '모네라가 부족해요 / No tienes suficientes moneras' });
  const newItems = { ...user.items, [itemId]: item.duration ? { expires: Date.now() + item.duration } : true };
  const newPoints = user.points - item.price;
  const { error: updateError } = await supabase.from('users').update({ items: newItems, points: newPoints }).eq('userId', userId);
  if (updateError) return res.status(500).json({ success: false });
  res.json({ success: true, items: newItems, points: newPoints });
});

// 포인트 공유
app.post('/share-points', verifyUser, async (req, res) => {
  const { toUserId, points } = req.body;
  const fromUserId = req.userId;
  const { data: fromUser, error: fromError } = await supabase.from('users').select('points').eq('userId', fromUserId).single();
  if (fromError) return res.status(500).json({ success: false });
  if (fromUser.points < points) return res.status(400).json({ success: false, message: '모네라가 부족해요 / No tienes suficientes moneras' });
  const { data: toUser, error: toError } = await supabase.from('users').select('points').eq('userId', toUserId).single();
  if (toError) return res.status(404).json({ success: false, message: '친구를 찾을 수 없어요 / No se encontró al amigo' });
  const newFromPoints = fromUser.points - points;
  const newToPoints = (toUser.points || 0) + points;
  await supabase.from('users').update({ points: newFromPoints }).eq('userId', fromUserId);
  await supabase.from('users').update({ points: newToPoints }).eq('userId', toUserId);
  res.json({ success: true, points: newFromPoints });
});

// 관리자 기능
app.post('/admin/points', verifyUser, async (req, res) => {
  const { password, points } = req.body;
  if (password !== '1210') return res.status(403).json({ success: false, message: '비밀번호가 틀렸어요 / Contraseña incorrecta' });
  const userId = req.userId;
  const { data: user, error } = await supabase.from('users').select('points').eq('userId', userId).single();
  if (error) return res.status(500).json({ success: false });
  const newPoints = (user.points || 0) + points;
  await supabase.from('users').update({ points: newPoints }).eq('userId', userId);
  res.json({ success: true, points: newPoints });
});

async function manageStorage() {
  const { data: messages, error: msgError } = await supabase.from('messages').select('id, message, type, timestamp');
  if (msgError) return;
  const { data: deletedMessages, error: delError } = await supabase.from('deleted_messages').select('id, timestamp');
  if (delError) return;
  const { data: files, error: fileError } = await supabase.storage.from('uploads').list();
  if (fileError) return;
  let totalSize = 0;
  messages.forEach(m => {
    if (m.type !== 'text') {
      const file = files.find(f => m.message.includes(f.name));
      totalSize += file ? file.metadata.size : 0;
    }
    totalSize += new Blob([m.message]).size;
  });
  deletedMessages.forEach(dm => totalSize += new Blob([JSON.stringify(dm)]).size);
  const maxSize = 400 * 1024 * 1024;
  if (totalSize > maxSize) {
    const sortedMessages = messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    let sizeToFree = totalSize - maxSize;
    for (const msg of sortedMessages) {
      if (sizeToFree <= 0) break;
      await supabase.from('messages').delete().eq('id', msg.id);
      if (msg.type !== 'text') {
        const fileName = msg.message.split('/').pop();
        await supabase.storage.from('uploads').remove([fileName]);
      }
      sizeToFree -= new Blob([msg.message]).size;
    }
  }
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const oldMessages = messages.filter(m => new Date(m.timestamp) < sevenDaysAgo && m.type !== 'text');
  for (const msg of oldMessages) {
    const fileName = msg.message.split('/').pop();
    await supabase.storage.from('uploads').remove([fileName]);
    await supabase.from('messages').delete().eq('id', msg.id);
  }
  const oldDeletedMessages = deletedMessages.filter(dm => new Date(dm.timestamp) < sevenDaysAgo);
  for (const dm of oldDeletedMessages) {
    await supabase.from('deleted_messages').delete().eq('id', dm.id);
  }
}

async function setupDatabase() {
  const { error } = await supabase.rpc('execute_sql', {
    sql: `
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS points INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS items JSONB DEFAULT '{}';
    `
  });
  if (error) console.log('테이블 수정 에러 / Error al modificar tabla:', error);
  else console.log('테이블 준비 완료 / Tabla lista!');
}

setupDatabase();

app.listen(process.env.PORT || 3000, () => {
  console.log(`서버가 http://localhost:${process.env.PORT || 3000}에서 실행 중이야! / ¡El servidor está corriendo!`);
});