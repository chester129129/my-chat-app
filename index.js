const express = require('express');
const app = express();
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static('public'));

function verifyUser(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: '로그인 필요 / Necesitas iniciar sesión' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    res.status(401).json({ success: false, message: '잘못된 토큰 / Token inválido' });
  }
}

app.post('/login', async (req, res) => {
  const { password, userId } = req.body;
  if (password !== process.env.PASSWORD) return res.status(401).json({ success: false });
  const { data, error } = await supabase.from('users').select('userId').eq('userId', userId).single();
  if (error && error.code !== 'PGRST116') {
    console.log('로그인 에러 / Error en login:', error);
    return res.status(500).json({ success: false });
  }
  if (!data) {
    const { error: insertError } = await supabase.from('users').insert({ userId, profilePic: '/uploads/default-profile.png' });
    if (insertError) {
      console.log('유저 생성 에러 / Error al crear usuario:', insertError);
      return res.status(500).json({ success: false });
    }
  }
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
  res.json({ success: true, token });
});

app.post('/logout', verifyUser, async (req, res) => {
  const { userId } = req.body;
  if (userId !== req.userId) return res.status(403).json({ success: false });
  res.json({ success: true });
});

app.get('/users', verifyUser, async (req, res) => {
  const { data, error } = await supabase.from('users').select('userId, profilePic');
  if (error) {
    console.log('유저 목록 에러 / Error al obtener lista de usuarios:', error);
    return res.status(500).json([]);
  }
  res.json(data);
});

app.get('/all-users', verifyUser, async (req, res) => {
  const { data, error } = await supabase.from('users').select('userId, profilePic');
  if (error) {
    console.log('전체 유저 목록 에러 / Error al obtener lista completa de usuarios:', error);
    return res.status(500).json([]);
  }
  res.json(data);
});

app.post('/friends', verifyUser, async (req, res) => {
  const { userId, friendId } = req.body;
  if (userId !== req.userId) return res.status(403).json({ success: false });
  const { data, error } = await supabase.from('friends').select().eq('userId', userId).eq('friendId', friendId);
  if (error) {
    console.log('친구 추가 조회 에러 / Error al verificar amigo:', error);
    return res.status(500).json({ success: false });
  }
  if (data.length > 0) return res.status(400).json({ success: false, message: '이미 친구임 / Ya es amigo' });
  const { error: insertError } = await supabase.from('friends').insert({ userId, friendId });
  if (insertError) {
    console.log('친구 추가 에러 / Error al añadir amigo:', insertError);
    return res.status(500).json({ success: false });
  }
  res.json({ success: true });
});

app.delete('/friends', verifyUser, async (req, res) => {
  const { userId, friendId } = req.body;
  if (userId !== req.userId) return res.status(403).json({ success: false });
  const { error } = await supabase.from('friends').delete().eq('userId', userId).eq('friendId', friendId);
  if (error) {
    console.log('친구 삭제 에러 / Error al eliminar amigo:', error);
    return res.status(500).json({ success: false });
  }
  res.json({ success: true });
});

app.get('/friends/:userId', verifyUser, async (req, res) => {
  const { userId } = req.params;
  if (userId !== req.userId) return res.status(403).json({ success: false });
  const { data, error } = await supabase.from('friends').select('friendId').eq('userId', userId);
  if (error) {
    console.log('친구 목록 에러 / Error al obtener lista de amigos:', error);
    return res.status(500).json([]);
  }
  res.json(data.map(f => f.friendId));
});

app.get('/rooms/:userId', verifyUser, async (req, res) => {
  const { userId } = req.params;
  if (userId !== req.userId) return res.status(403).json({ success: false });
  const { data: friends, error: friendError } = await supabase.from('friends').select('friendId').eq('userId', userId);
  if (friendError) {
    console.log('친구 목록 조회 에러 / Error al obtener amigos en rooms:', friendError);
    return res.status(500).json([]);
  }
  const friendIds = friends.map(f => f.friendId);
  const rooms = [];
  for (const friendId of friendIds) {
    const roomId = [userId, friendId].sort().join('-');
    const { data: messages, error: msgError } = await supabase.from('messages').select('message, timestamp').eq('roomId', roomId).order('timestamp', { ascending: false }).limit(1);
    if (msgError) {
      console.log('마지막 메시지 조회 에러 / Error al obtener último mensaje:', msgError);
      continue;
    }
    const { data: unread, error: unreadError } = await supabase.from('unread').select('messageId').eq('roomId', roomId).eq('userId', userId);
    if (unreadError) {
      console.log('읽지 않은 메시지 조회 에러 / Error al obtener mensajes no leídos:', unreadError);
      continue;
    }
    rooms.push({ roomId, lastMessage: messages[0], unreadCount: unread.length });
  }
  res.json(rooms);
});

app.get('/chat/:roomId/:userId', verifyUser, async (req, res) => {
  const { roomId, userId } = req.params;
  if (!roomId.includes(userId)) return res.status(403).json({ success: false });
  const { data, error } = await supabase.from('messages').select('*').eq('roomId', roomId).order('timestamp', { ascending: true });
  if (error) {
    console.log('채팅 조회 에러 / Error al obtener chat:', error);
    return res.status(500).json([]);
  }
  await supabase.from('unread').delete().eq('roomId', roomId).eq('userId', userId);
  res.json(data);
});

app.get('/all-chat', verifyUser, async (req, res) => {
  const { data, error } = await supabase.from('messages').select('*').eq('roomId', 'all-chat').order('timestamp', { ascending: true }).limit(30);
  if (error) {
    console.log('전체 채팅 조회 에러 / Error al obtener chat general:', error);
    return res.status(500).json([]);
  }
  res.json(data);
});

app.post('/chat', verifyUser, async (req, res) => {
  const { roomId, from, message } = req.body;
  if (roomId !== 'all-chat' && !roomId.includes(from)) return res.status(403).json({ success: false });
  const { data, error } = await supabase.from('messages').insert({ roomId, from, message, type: 'text', timestamp: new Date().toISOString() }).select().single();
  if (error) {
    console.log('메시지 전송 에러 / Error al enviar mensaje:', error);
    return res.status(500).json({ success: false });
  }
  if (roomId !== 'all-chat') {
    const to = roomId.split('-').find(id => id !== from);
    const { error: unreadError } = await supabase.from('unread').insert({ roomId, userId: to, messageId: data.id });
    if (unreadError) {
      console.log('읽지 않음 추가 에러 / Error al añadir no leído:', unreadError);
    }
  }
  if (roomId === 'all-chat') {
    const { data: allMessages, error: fetchError } = await supabase.from('messages').select('id').eq('roomId', 'all-chat').order('timestamp', { ascending: true });
    if (!fetchError && allMessages.length > 30) {
      const excess = allMessages.slice(0, allMessages.length - 30);
      await supabase.from('messages').delete().in('id', excess.map(m => m.id));
    }
  }
  res.json({ success: true });
});

app.post('/chat/delete/:roomId/:userId', verifyUser, async (req, res) => {
  const { roomId, userId } = req.params;
  if (!roomId.includes(userId)) return res.status(403).json({ success: false });
  const { data: messages, error: fetchError } = await supabase.from('messages').select('id, message, type').eq('roomId', roomId);
  if (fetchError) {
    console.log('메시지 조회 에러 / Error al obtener mensajes para eliminar:', fetchError);
    return res.status(500).json({ success: false });
  }
  const { error: moveError } = await supabase.from('deleted_messages').insert(messages.map(m => ({
    id: m.id,
    roomId,
    message: m.message,
    type: m.type,
    timestamp: new Date().toISOString()
  })));
  if (moveError) {
    console.log('삭제된 메시지로 이동 에러 / Error al mover a mensajes eliminados:', moveError);
    return res.status(500).json({ success: false });
  }
  const { error: deleteError } = await supabase.from('messages').delete().eq('roomId', roomId);
  if (deleteError) {
    console.log('메시지 삭제 에러 / Error al eliminar mensajes:', deleteError);
    return res.status(500).json({ success: false });
  }
  await supabase.from('unread').delete().eq('roomId', roomId);
  res.json({ success: true });
});

app.post('/upload', verifyUser, upload.single('file'), async (req, res) => {
  const { roomId, from } = req.body;
  if (roomId !== 'all-chat' && !roomId.includes(from)) return res.status(403).json({ success: false });
  const fileName = `${roomId}-${Date.now()}.${req.file.mimetype.split('/')[1]}`;
  const { error: uploadError } = await supabase.storage.from('uploads').upload(fileName, req.file.buffer, {
    contentType: req.file.mimetype,
  });
  if (uploadError) {
    console.log('파일 업로드 에러 / Error al subir archivo:', uploadError);
    return res.status(500).json({ success: false });
  }
  const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(fileName);
  const fileUrl = urlData.publicUrl;
  const type = req.file.mimetype.startsWith('image') ? 'image' : 'video';
  const { data, error } = await supabase.from('messages').insert({ roomId, from, message: fileUrl, type, timestamp: new Date().toISOString() }).select().single();
  if (error) {
    console.log('미디어 메시지 전송 에러 / Error al enviar mensaje multimedia:', error);
    return res.status(500).json({ success: false });
  }
  if (roomId !== 'all-chat') {
    const to = roomId.split('-').find(id => id !== from);
    const { error: unreadError } = await supabase.from('unread').insert({ roomId, userId: to, messageId: data.id });
    if (unreadError) {
      console.log('읽지 않음 추가 에러 / Error al añadir no leído:', unreadError);
    }
  }
  res.json({ success: true });
});

app.post('/upload/voice', verifyUser, upload.single('voice'), async (req, res) => {
  const { roomId, from } = req.body;
  if (roomId !== 'all-chat' && !roomId.includes(from)) return res.status(403).json({ success: false });
  const fileName = `${roomId}-${Date.now()}.wav`;
  const { error: uploadError } = await supabase.storage.from('uploads').upload(fileName, req.file.buffer, {
    contentType: 'audio/wav',
  });
  if (uploadError) {
    console.log('음성 업로드 에러 / Error al subir voz:', uploadError);
    return res.status(500).json({ success: false });
  }
  const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(fileName);
  const fileUrl = urlData.publicUrl;
  const { data, error } = await supabase.from('messages').insert({ roomId, from, message: fileUrl, type: 'voice', timestamp: new Date().toISOString() }).select().single();
  if (error) {
    console.log('음성 메시지 전송 에러 / Error al enviar mensaje de voz:', error);
    return res.status(500).json({ success: false });
  }
  if (roomId !== 'all-chat') {
    const to = roomId.split('-').find(id => id !== from);
    const { error: unreadError } = await supabase.from('unread').insert({ roomId, userId: to, messageId: data.id });
    if (unreadError) {
      console.log('읽지 않음 추가 에러 / Error al añadir no leído:', unreadError);
    }
  }
  res.json({ success: true });
});

app.post('/upload/profile', verifyUser, upload.single('profile'), async (req, res) => {
  const { userId } = req.body;
  if (!userId || !req.file) return res.status(400).json({ success: false });
  if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });

  // 기존 프로필 사진 URL 가져오기
  const { data: user, error: fetchError } = await supabase.from('users').select('profilePic').eq('userId', userId).single();
  if (fetchError) {
    console.log('프로필 사진 조회 에러 / Error al obtener foto de perfil:', fetchError);
    return res.status(500).json({ success: false });
  }

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

  // 기존 사진 삭제 (기본 사진이 아닌 경우만)
  if (user.profilePic && user.profilePic !== '/uploads/default-profile.png') {
    const oldFileName = user.profilePic.split('/').pop();
    const { error: deleteError } = await supabase.storage.from('uploads').remove([oldFileName]);
    if (deleteError) {
      console.log('이전 프로필 사진 삭제 에러 / Error al eliminar foto anterior:', deleteError);
    } else {
      console.log('이전 사진 삭제 성공 / Foto anterior eliminada:', oldFileName);
    }
  }

  // 새 사진 URL로 업데이트
  const { error } = await supabase.from('users').update({ profilePic: fileUrl }).eq('userId', userId);
  if (error) {
    console.log('프로필 사진 업데이트 에러 / Error al actualizar foto de perfil:', error);
    return res.status(500).json({ success: false });
  }

  res.json({ success: true, profilePic: fileUrl });
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

setInterval(manageStorage, 1000 * 60 * 60); // 1시간마다 실행

const PORT = process.env.PORT || 3000;
app.listen(process.env.PORT || 3000, () => {
  console.log(`서버가 http://localhost:${process.env.PORT || 3000}에서 실행 중이야! / ¡El servidor está corriendo!`);
});