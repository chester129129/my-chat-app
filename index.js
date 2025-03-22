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
  console.error('Supabase 연결 실패: 환경 변수를 확인하세요 / Fallo en la conexión a Supabase: revisa las variables de entorno (SUPABASE_URL, SUPABASE_ANON_KEY)');
}

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const upload = multer({ storage: multer.memoryStorage() });

// Middleware to verify JWT and extract userId
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
    const { error: insertError } = await supabase.from('users').insert({ userId, friends: [], online: true, profilePic: '/uploads/default-profile.png' });
    if (insertError) {
      console.log('로그인 - 유저 생성 에러 / Error al crear usuario en login:', insertError);
      return res.status(500).json({ success: false, message: '유저 생성 실패 / Error al crear usuario' });
    }
  } else {
    const { error: updateError } = await supabase.from('users').update({ online: true }).eq('userId', userId);
    if (updateError) {
      console.log('로그인 - 유저 업데이트 에러 / Error al actualizar usuario en login:', updateError);
      return res.status(500).json({ success: false, message: '유저 업데이트 실패 / Error al actualizar usuario' });
    }
  }
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
  res.json({ success: true, userId, token });
});

app.post('/logout', verifyUser, async (req, res) => {
  const { userId } = req.body;
  const { error } = await supabase.from('users').update({ online: false }).eq('userId', userId);
  if (error) {
    console.log('로그아웃 에러 / Error al cerrar sesión:', error);
    return res.status(500).json({ success: false });
  }
  res.json({ success: true });
});

app.get('/users', async (req, res) => {
  const { data, error } = await supabase.from('users').select('userId, profilePic').eq('online', true);
  if (error) {
    console.log('유저 가져오기 에러 / Error al obtener usuarios:', error);
    return res.status(500).json([]);
  }
  res.json(data.map(u => ({ userId: u.userId, profilePic: u.profilePic || '/uploads/default-profile.png' })));
});

app.get('/all-users', async (req, res) => {
  const { data, error } = await supabase.from('users').select('userId, profilePic');
  if (error) {
    console.log('모든 유저 가져오기 에러 / Error al obtener todos los usuarios:', error);
    return res.status(500).json([]);
  }
  res.json(data.map(u => ({ userId: u.userId, profilePic: u.profilePic || '/uploads/default-profile.png' })));
});

app.post('/friends', verifyUser, async (req, res) => {
  const { userId, friendId } = req.body;
  if (!userId || !friendId) return res.status(400).json({ success: false });
  if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  const { data: user } = await supabase.from('users').select('friends').eq('userId', userId).single();
  if (!user) {
    await supabase.from('users').insert({ userId, friends: [friendId], online: true, profilePic: '/uploads/default-profile.png' });
    res.json({ success: true, friendId });
  } else if (!user.friends.includes(friendId)) {
    const { error } = await supabase.from('users').update({ friends: [...user.friends, friendId] }).eq('userId', userId);
    if (error) {
      console.log('친구 추가 에러 / Error al añadir amigo:', error);
      return res.status(500).json({ success: false });
    }
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
  if (error) {
    console.log('친구 삭제 에러 / Error al eliminar amigo:', error);
    return res.status(500).json({ success: false });
  }
  res.json({ success: true, friendId });
});

app.get('/friends/:userId', verifyUser, async (req, res) => {
  const userId = req.params.userId;
  if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  const { data: user, error } = await supabase.from('users').select('friends').eq('userId', userId).single();
  if (error || !user) {
    console.log('친구 목록 에러 / Error al obtener lista de amigos:', error);
    return res.json([]);
  }
  res.json(user.friends || []);
});

app.get('/rooms/:userId', verifyUser, async (req, res) => {
  const userId = req.params.userId;
  if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  const { data: messages, error } = await supabase.from('messages').select('*').ilike('room', `*${userId}*`).order('timestamp', { ascending: false });
  if (error) {
    console.log('채팅방 목록 에러 / Error al obtener lista de salas de chat:', error);
    return res.status(500).json([]);
  }
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
  if (error) {
    console.log('전체 채팅 가져오기 에러 / Error al obtener chat general:', error);
    return res.status(500).json([]);
  }
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
    supabase
      .from('messages')
      .select('*')
      .eq('room', roomId)
      .order('timestamp', { ascending: true }),
    supabase
      .from('deleted_messages')
      .select('messageId')
      .eq('userId', userId)
      .eq('roomId', roomId)
  ]);

  const { data: messages, error: msgError } = messagesRes;
  if (msgError) {
    console.log('채팅 기록 가져오기 에러 / Error al obtener historial de chat:', msgError);
    return res.status(500).json({ success: false, message: '채팅 기록 가져오기 실패 / Error al obtener historial de chat' });
  }

  const { data: deleted, error: delError } = deletedRes;
  if (delError) {
    console.log('삭제된 메시지 가져오기 에러 / Error al obtener mensajes eliminados:', delError);
    return res.status(500).json({ success: false, message: '삭제된 메시지 가져오기 실패 / Error al obtener mensajes eliminados' });
  }

  const deletedIds = deleted.map(d => d.messageId);
  const filteredMessages = messages.filter(m => !deletedIds.includes(m.id));

  const { error: updateError } = await supabase.from('messages').update({ read: true }).eq('room', roomId).eq('read', false);
  if (updateError) {
    console.log('읽음 상태 업데이트 에러 / Error al actualizar estado de lectura:', updateError);
  }

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
  if (error) {
    console.log('메시지 삽입 에러 / Error al insertar mensaje:', error);
    return res.status(500).json({ success: false, message: '메시지 삽입 실패 / Error al insertar mensaje' });
  }

  manageStorage().catch(err => console.log('manageStorage 에러 / Error en manageStorage:', err));

  res.json({ success: true, message: data });
});

app.post('/upload', verifyUser, upload.single('file'), async (req, res) => {
  const { roomId, from } = req.body;
  if (!roomId || !from || !req.file) return res.status(400).json({ success: false });
  if (from !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  const fileName = `${Date.now()}-${req.file.originalname}`;
  const { error: uploadError } = await supabase.storage.from('uploads').upload(fileName, req.file.buffer, {
    contentType: req.file.mimetype,
  });
  if (uploadError) {
    console.log('파일 업로드 에러 / Error al subir archivo:', uploadError);
    return res.status(500).json({ success: false });
  }
  const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(fileName);
  const fileUrl = urlData.publicUrl;
  const messageData = { room: roomId, from, message: fileUrl, type: req.file.mimetype.startsWith('image') ? 'image' : 'video', timestamp: new Date(), read: false };
  const { data, error } = await supabase.from('messages').insert(messageData).select().single();
  if (error) {
    console.log('메시지 삽입 에러 / Error al insertar mensaje:', error);
    return res.status(500).json({ success: false });
  }
  await manageStorage();
  res.json({ success: true, message: data });
});

app.post('/upload/profile', verifyUser, upload.single('profile'), async (req, res) => {
  const { userId } = req.body;
  if (!userId || !req.file) return res.status(400).json({ success: false });
  if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });

  // 기존 프로필 사진 가져오기
  const { data: userData, error: userError } = await supabase.from('users').select('profilePic').eq('userId', userId).single();
  if (userError) {
    console.log('프로필 사진 조회 에러 / Error al obtener foto de perfil:', userError);
    return res.status(500).json({ success: false });
  }

  const oldProfilePic = userData.profilePic;
  const isDefaultPic = oldProfilePic === '/uploads/default-profile.png';

  // 새 프로필 사진 업로드
  const fileName = `${userId}-${Date.now()}.jpg`;
  const { error: uploadError } = await supabase.storage.from('uploads').upload(fileName, req.file.buffer, {
    contentType: req.file.mimetype,
  });
  if (uploadError) {
    console.log('프로필 사진 업로드 에러 / Error al subir foto de perfil:', uploadError);
    return res.status(500).json({ success: false });
  }
  const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(fileName);
  const fileUrl = urlData.publicUrl;

  // 사용자 정보 업데이트
  const { error: updateError } = await supabase.from('users').update({ profilePic: fileUrl }).eq('userId', userId);
  if (updateError) {
    console.log('프로필 사진 업데이트 에러 / Error al actualizar foto de perfil:', updateError);
    return res.status(500).json({ success: false });
  }

  // 이전 프로필 사진 삭제 (기본 사진이 아닌 경우만)
  if (!isDefaultPic) {
    const oldFileName = oldProfilePic.split('/').pop();
    const { error: deleteError } = await supabase.storage.from('uploads').remove([oldFileName]);
    if (deleteError) {
      console.log('이전 프로필 사진 삭제 에러 / Error al eliminar foto de perfil anterior:', deleteError);
    }
  }

  res.json({ success: true, profilePic: fileUrl });
});

app.post('/upload/voice', verifyUser, upload.single('voice'), async (req, res) => {
  const { roomId, from } = req.body;
  if (!roomId || !from || !req.file) return res.status(400).json({ success: false });
  if (from !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  const fileName = `${Date.now()}-voice.wav`;
  const { error: uploadError } = await supabase.storage.from('uploads').upload(fileName, req.file.buffer, {
    contentType: 'audio/wav',
  });
  if (uploadError) {
    console.log('음성 업로드 에러 / Error al subir audio:', uploadError);
    return res.status(500).json({ success: false });
  }
  const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(fileName);
  const fileUrl = urlData.publicUrl;
  const messageData = { room: roomId, from, message: fileUrl, type: 'voice', timestamp: new Date(), read: false };
  const { data, error } = await supabase.from('messages').insert(messageData).select().single();
  if (error) {
    console.log('음성 메시지 삽입 에러 / Error al insertar mensaje de voz:', error);
    return res.status(500).json({ success: false });
  }
  await manageStorage();
  res.json({ success: true, message: data });
});

app.post('/chat/delete/:roomId/:userId', verifyUser, async (req, res) => {
  const roomId = req.params.roomId;
  const userId = req.params.userId;
  if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });

  const { data: messages, error: msgError } = await supabase.from('messages').select('id').eq('room', roomId);
  if (msgError) {
    console.log('채팅 삭제 - 메시지 가져오기 에러 / Error al obtener mensajes para eliminar chat:', msgError);
    return res.status(500).json({ success: false, message: '메시지 가져오기 실패 / Error al obtener mensajes' });
  }

  if (!messages || messages.length === 0) {
    console.log('삭제할 메시지가 없음 / No hay mensajes para eliminar', { roomId, userId });
    return res.json({ success: true, message: '삭제할 메시지가 없음 / No hay mensajes para eliminar' });
  }

  const deletedEntries = messages.map(m => ({
    userId,
    roomId,
    messageId: m.id,
    timestamp: new Date().toISOString()
  }));
  const { error: insertError } = await supabase.from('deleted_messages').insert(deletedEntries);
  if (insertError) {
    console.log('채팅 삭제 - 삽입 에러 / Error al insertar eliminación de chat:', insertError);
    return res.status(500).json({ success: false, message: '삭제 기록 삽입 실패 / Error al insertar registro de eliminación', error: insertError.message });
  }

  console.log('삭제 기록 삽입 성공 / Registro de eliminación insertado', { roomId, userId, count: deletedEntries.length });
  res.json({ success: true });
});

async function manageStorage() {
  const { data: messages, error: msgError } = await supabase.from('messages').select('id, message, type, timestamp');
  if (msgError) {
    console.log('manageStorage - 메시지 가져오기 에러 / Error al obtener mensajes en manageStorage:', msgError);
    return;
  }

  const { data: deletedMessages, error: delError } = await supabase.from('deleted_messages').select('id, timestamp');
  if (delError) {
    console.log('manageStorage - 삭제된 메시지 가져오기 에러 / Error al obtener mensajes eliminados en manageStorage:', delError);
    return;
  }

  const { data: files, error: fileError } = await supabase.storage.from('uploads').list();
  if (fileError) {
    console.log('manageStorage - 파일 목록 가져오기 에러 / Error al obtener lista de archivos en manageStorage:', fileError);
    return;
  }

  let totalSize = 0;
  messages.forEach(m => {
    if (m.type !== 'text') {
      const file = files.find(f => m.message.includes(f.name));
      totalSize += file ? file.metadata.size : 0;
    }
    totalSize += new Blob([m.message]).size;
  });

  deletedMessages.forEach(dm => {
    totalSize += new Blob([JSON.stringify(dm)]).size;
  });

  const maxSize = 400 * 1024 * 1024; // 400MB
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

app.listen(process.env.PORT || 3000, () => {
  console.log(`서버가 http://localhost:${process.env.PORT || 3000}에서 실행 중이야! / ¡El servidor está corriendo!`);
});