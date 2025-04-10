const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
console.log('Supabase 연결 테스트 / Prueba de conexión a Supabase:', supabase ? '성공 / Éxito' : '실패 / Fallo');
if (!supabase) {
  console.error('Supabase 연결 실패: 환경 변수를 확인하세요 / Fallo en la conexión a Supabase: revisa las variables de entorno (SUPABASE_URL, SUPABASE_ANON_KEY)');
}

// VAPID 키 설정 (환경 변수에서 가져오기)
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT;

if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
  console.error('VAPID 키가 .env 파일에 설정되지 않았습니다! / ¡Las claves VAPID no están configuradas en el archivo .env!');
} else {
  webpush.setVapidDetails(
    vapidSubject,
    vapidPublicKey,
    vapidPrivateKey
  );
  console.log('WebPush VAPID 설정 완료 / Configuración VAPID de WebPush completada');
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
  if (!userId) return res.status(400).json({ success: false, message: 'userId가 필요해요 / Necesitas un userId' });
  if (password !== process.env.PASSWORD) {
    console.log(`로그인 실패 (비밀번호 불일치): ${userId}`);
    return res.status(401).json({ success: false, message: '비밀번호가 틀렸어요! / ¡Contraseña incorrecta!' });
  }

  try {
    const { data: user, error: selectError } = await supabase.from('users').select('*').eq('userId', userId).single();
    if (selectError && selectError.code !== 'PGRST116') { // PGRST116: 레코드가 없는 경우
      console.log('로그인 - 유저 조회 에러 / Error al consultar usuario en login:', selectError);
      return res.status(500).json({ success: false, message: '서버 에러 / Error del servidor' });
    }

    if (!user) {
      // 신규 유저 생성
      const { error: insertError } = await supabase.from('users').insert({
        userId,
        friends: [],
        online: true,
        profilePic: '/uploads/default-profile.png',
        monera: 0
      });
      if (insertError) {
        console.log('로그인 - 유저 생성 에러 / Error al crear usuario en login:', insertError);
        return res.status(500).json({ success: false, message: '유저 생성 실패 / Error al crear usuario' });
      }
      console.log(`📱 신규 사용자 가입 및 로그인: ${userId}`);
    } else {
      // 기존 유저 온라인 상태 업데이트
      const { error: updateError } = await supabase.from('users').update({ online: true }).eq('userId', userId);
      if (updateError) {
        console.log('로그인 - 유저 업데이트 에러 / Error al actualizar usuario en login:', updateError);
        return res.status(500).json({ success: false, message: '유저 업데이트 실패 / Error al actualizar usuario' });
      }
      console.log(`📱 사용자 로그인: ${userId}`);
    }

    const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, userId, token });
  } catch (error) {
    console.log('로그인 처리 중 예상치 못한 에러 / Error inesperado en login:', error);
    return res.status(500).json({ success: false, message: '서버 에러가 발생했어요 / Ocurrió un error en el servidor' });
  }
});

app.post('/logout', verifyUser, async (req, res) => {
  const { userId } = req.body;
  const { error } = await supabase.from('users').update({ online: false }).eq('userId', userId);
  if (error) {
    console.log('로그아웃 에러 / Error al cerrar sesión:', error);
    return res.status(500).json({ success: false });
  }
  console.log(`📱 사용자 로그아웃: ${userId}`);
  res.json({ success: true });
});

app.get('/users', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('userId, profilePic, online').eq('online', true);
    if (error) {
      console.log('유저 가져오기 에러 / Error al obtener usuarios:', error);
      return res.status(500).json([]);
    }
    
    // 상세 로그 대신 간단한 요약 제공 (변경사항이 있을 때만 주석 해제해서 사용)
    // console.log(`👥 접속 중인 사용자: ${data.length}명`);
    
    res.json(data.map(u => ({ userId: u.userId, profilePic: u.profilePic || '/uploads/default-profile.png' })));
  } catch (error) {
    console.log('유저 목록 조회 중 에러 / Error al obtener lista de usuarios:', error);
    res.status(500).json([]);
  }
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
    console.log(`👫 친구 추가: ${userId} → ${friendId} (신규 사용자)`);
    res.json({ success: true, friendId });
  } else if (!user.friends.includes(friendId)) {
    const { error } = await supabase.from('users').update({ friends: [...user.friends, friendId] }).eq('userId', userId);
    if (error) {
      console.log('친구 추가 에러 / Error al añadir amigo:', error);
      return res.status(500).json({ success: false });
    }
    console.log(`👫 친구 추가: ${userId} → ${friendId}`);
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
  try {
    // since 쿼리 파라미터 확인
    const sinceTimestamp = req.query.since;
    
    // 로그 출력 제거
    
    let query = supabase.from('messages').select('*').eq('room', 'all-chat');
    
    if (sinceTimestamp) {
      // 유효한 타임스탬프인지 확인
      try {
        const sinceDate = new Date(sinceTimestamp);
        if (!isNaN(sinceDate.getTime())) {
          // 해당 타임스탬프 이후의 메시지만 가져옴
          query = query.gt('timestamp', sinceTimestamp);
        }
      } catch (error) {
        console.log('타임스탬프 파싱 에러 / Error al analizar timestamp:', error);
        // 유효하지 않은 타임스탬프면 필터링 없이 진행
      }
    }
    
    // 항상 시간순으로 정렬
    query = query.order('timestamp', { ascending: true });
    
    // since가 없으면 최신 30개만 가져옴
    if (!sinceTimestamp) {
      query = query.limit(30);
    }
    
    const { data, error } = await query;
    
    if (error) {
      console.log('전체 채팅 가져오기 에러 / Error al obtener chat general:', error);
      return res.status(500).json([]);
    }
    
    // 새 메시지가 있을 때만 간결하게 로그 출력 (주기적 폴링의 경우)
    if (sinceTimestamp && data && data.length > 0) {
      console.log(`📢 전체 채팅 새 메시지: ${data.length}개`);
    }
    
    // 초기 로딩 로그 제거
    
    // 30개 초과 시 오래된 메시지 삭제 (기존 로직 유지)
    if (!sinceTimestamp && data.length > 30) {
      const excess = data.length - 30;
      const oldest = data.slice(0, excess).map(m => m.id);
      await supabase.from('messages').delete().in('id', oldest);
      console.log(`🧹 전체 채팅 자동 정리: ${excess}개 메시지 삭제됨`);
    }
    
    res.json(data);
  } catch (error) {
    console.log('전체 채팅 처리 중 예상치 못한 에러 / Error inesperado al procesar chat general:', error);
    res.status(500).json([]);
  }
});

app.get('/chat/:roomId/:userId', verifyUser, async (req, res) => {
  const roomId = req.params.roomId;
  const userId = req.params.userId;
  
  if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });

  try {
    // since 파라미터 확인 (주기적 폴링 여부 판단용)
    const sinceTimestamp = req.query.since;
    
    // 주기적 폴링이 아닐 때도 로그 출력하지 않음
    
    // 삭제된 메시지 정보 및 삭제 시점 조회
    const { data: deleted, error: delError } = await supabase
      .from('deleted_messages')
      .select('messageId, timestamp')
      .eq('userId', userId)
      .eq('roomId', roomId);
      
    if (delError) {
      console.log('삭제된 메시지 가져오기 에러 / Error al obtener mensajes eliminados:', delError);
      return res.status(500).json({ success: false, message: '삭제된 메시지 가져오기 실패 / Error al obtener mensajes eliminados' });
    }

    // 삭제 시점 가져오기 (없으면 과거 날짜 사용)
    let deleteTimestamp = '1970-01-01T00:00:00.000Z';
    if (deleted && deleted.length > 0) {
      // 가장 최근 삭제 시점 찾기
      const timestamps = deleted.map(d => d.timestamp).filter(t => t); // null/undefined 제거
      if (timestamps.length > 0) {
        deleteTimestamp = new Date(Math.max(...timestamps.map(t => new Date(t).getTime()))).toISOString();
        // 로그 출력하지 않음
      }
    }
    
    let messages = [];
    
    if (sinceTimestamp) {
      // Case 1: sinceTimestamp가 있는 경우 - 이 시점 이후 메시지 모두 가져오기 (limit 없음)
      try {
        const sinceDate = new Date(sinceTimestamp);
        if (!isNaN(sinceDate.getTime())) {
          const { data: recentMessages, error: msgError } = await supabase
            .from('messages')
            .select('*')
            .eq('room', roomId)
            .gt('timestamp', sinceTimestamp)
            .order('timestamp', { ascending: true });
            
          if (msgError) {
            console.log('최근 채팅 기록 가져오기 에러 / Error al obtener historial de chat reciente:', msgError);
            return res.status(500).json({ success: false, message: '채팅 기록 가져오기 실패 / Error al obtener historial de chat' });
          }
          
          messages = recentMessages || [];
          
          // 새 메시지가 있을 때만 간결하게 로그 출력
          if (messages.length > 0) {
            console.log(`📨 새 메시지: ${roomId} (${messages.length}개)`);
          }
        }
      } catch (error) {
        console.log('타임스탬프 파싱 에러 / Error al analizar timestamp:', error);
        // 유효하지 않은 타임스탬프 처리 - 이 경우 기본 로직으로 넘어감
      }
    } else {
      // Case 2: sinceTimestamp가 없는 경우 - 두 부분으로 나누어 조회
      
      // Case 2a: 삭제 시점 이전 메시지 - limit 적용하여 가져옴
      const { data: beforeDeleteMessages, error: beforeError } = await supabase
        .from('messages')
        .select('*')
        .eq('room', roomId)
        .lte('timestamp', deleteTimestamp)
        .order('timestamp', { ascending: false }) // 내림차순으로 최근 50개
        .limit(50);
        
      if (beforeError) {
        console.log('삭제 시점 이전 메시지 가져오기 에러:', beforeError);
        return res.status(500).json({ success: false, message: '채팅 기록 가져오기 실패' });
      }
      
      // 삭제된 메시지 ID Set 생성 (효율적인 검색을 위해)
      const deletedIds = new Set(deleted.map(d => d.messageId));
      
      // 삭제 시점 이전 메시지에서 삭제된 메시지 필터링
      const filteredBeforeMessages = (beforeDeleteMessages || [])
        .filter(m => !deletedIds.has(m.id))
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)); // 시간 오름차순 정렬
      
      // Case 2b: 삭제 시점 이후 메시지 - 모두 가져옴 (limit 없음)
      const { data: afterDeleteMessages, error: afterError } = await supabase
        .from('messages')
        .select('*')
        .eq('room', roomId)
        .gt('timestamp', deleteTimestamp)
        .order('timestamp', { ascending: true });
        
      if (afterError) {
        console.log('삭제 시점 이후 메시지 가져오기 에러:', afterError);
        return res.status(500).json({ success: false, message: '채팅 기록 가져오기 실패' });
      }
      
      // 두 결과 합치기 (Map을 사용하여 중복 방지)
      const messageMap = new Map();
      
      // 필터링된 삭제 시점 이전 메시지 추가
      filteredBeforeMessages.forEach(m => messageMap.set(m.id, m));
      
      // 삭제 시점 이후 메시지 추가 (필터링 없이 모두)
      (afterDeleteMessages || []).forEach(m => messageMap.set(m.id, m));
      
      // Map에서 배열로 변환하고 시간순 정렬
      messages = Array.from(messageMap.values())
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      
      // 읽음 상태 업데이트 - 상대방이 보낸 읽지 않은 메시지만
      if (messages.length > 0) {
        const unreadMessageIds = messages
          .filter(m => m.from !== userId && m.read === false)
          .map(m => m.id);
          
        if (unreadMessageIds.length > 0) {
          const { error: updateError } = await supabase
            .from('messages')
            .update({ read: true })
            .in('id', unreadMessageIds);
            
          if (updateError) {
            console.log('읽음 상태 업데이트 에러 / Error al actualizar estado de lectura:', updateError);
          }
          // 읽음 처리 로그 제거
        }
      }
    }

    res.json(messages);
  } catch (error) {
    console.log('채팅 처리 중 예상치 못한 에러 / Error inesperado al procesar chat:', error);
    res.status(500).json([]);
  }
});

app.post('/chat', verifyUser, async (req, res) => {
  const { roomId, from, message, color } = req.body;
  if (!roomId || !from || !message) return res.status(400).json({ success: false, message: '필수 필드가 누락됨 / Faltan campos requeridos' });
  if (from !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });

  let finalMessage = message;
  const isEmojiOnly = /^[\p{Emoji}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Emoji_Modifier_Base}\p{Emoji_Component}]+$/u.test(message);

  if (!isEmojiOnly) {
    try {
      const result = await model.generateContent(`너는 한국어와 유럽 스페인어 전문가야. "${message}"를 자연스럽게 번역해줘.단,최대한 원문에 가깝게 번역해줘.더럽거나 성적인말은 순화해서 표현해주고 무례해서는 안돼. 한국말로 높임말을 쓰면 그 다음 번역에서 1번만 한국말을 높임말로 번역해줘.너랑 대화하려는게 아니니까 너가 생각해서 응답하지말고 넌 그냥 번역한 결과만 전달하면 돼. 결과는 "한국어: [번역]\n스페인어: [번역]" 형식으로, 부가 설명 없이 두 문장만 써줘.`);
      const lines = result.response.text().split('\n');
      const translatedKr = lines[0].replace('한국어: ', '').trim();
      const translatedEs = lines[1] ? lines[1].replace('스페인어: ', '').trim() : 'Error en la traducción';
      finalMessage = `🇰🇷 ${translatedKr}\n🇪🇸 ${translatedEs}`;
    } catch (error) {
      console.log('번역 에러 / Error de traducción:', error);
      finalMessage = '번역 실패 / Traducción fallida';
    }
  }

  const messageData = { 
    room: roomId, 
    from, 
    message: finalMessage, 
    type: 'text', 
    timestamp: new Date(), 
    read: false,
    color: color || 'black' 
  };
  const { data: insertedMessage, error } = await supabase.from('messages').insert(messageData).select().single();

  if (error) {
    console.log('메시지 저장 에러 / Error al guardar mensaje:', error);
    return res.status(500).json({ success: false, message: '메시지 전송 실패 / Error al enviar mensaje' });
  }
  
  // --- 푸시 알림 보내기 로직 수정 ---
  // 1:1 채팅이고, 전체 채팅이 아닐 때만 푸시 알림 시도
  if (roomId !== 'all-chat') {
    // 수신자 ID 찾기 (roomId는 'userId1-userId2' 형식이라고 가정)
    const participants = roomId.split('-');
    const recipientId = participants.find(id => id !== from); // 메시지 보낸 사람이 아닌 다른 사람

    if (recipientId) {
      try {
        // 수신자의 정보 (pushenabled, pushsubscription) 가져오기
        const { data: recipientData, error: recipientError } = await supabase
          .from('users')
          .select('pushenabled, pushsubscription')
          .eq('userId', recipientId)
          .single();

        if (recipientError && recipientError.code !== 'PGRST116') { // 레코드 없음 외의 에러
          console.error('수신자 정보 조회 에러:', recipientError);
        } else if (recipientData && recipientData.pushenabled && recipientData.pushsubscription) {
          // 수신자가 알림을 켜뒀고, 구독 정보가 있을 때만 푸시 보내기
          console.log(`🔔 푸시 알림 전송 시도: ${from} → ${recipientId}`);
          
          // 알림 내용 구성
          const notificationPayload = JSON.stringify({
            title: `${from}님의 새 메시지 / Nuevo mensaje de ${from}`,
            body: message.length > 50 ? message.substring(0, 47) + '...' : message, // 메시지 미리보기 (너무 길면 자르기)
            icon: '/icons/icon-192x192.png', // 서비스 워커와 동일한 아이콘 사용
            badge: '/icons/badge-72x72.png',
            data: {
                url: `/chat?room=${roomId}` // 알림 클릭 시 이동할 URL (프론트엔드에서 이 URL을 처리하도록 만들어야 함)
            }
          });

          // 푸시 알림 전송
          await webpush.sendNotification(recipientData.pushsubscription, notificationPayload)
            .then(response => {
              console.log(`🔔 푸시 알림 전송 성공: ${from} → ${recipientId}`);
            })
            .catch(err => {
              console.error('푸시 알림 전송 실패 / Error al enviar notificación push:', err);
              // 구독이 만료되었거나 잘못된 경우 (410 Gone, 404 Not Found 등)
              if (err.statusCode === 410 || err.statusCode === 404) {
                console.log(`❌ 만료된 푸시 구독 정보 감지: ${recipientId} (삭제 처리)`);
                // DB에서 해당 구독 정보 삭제
                supabase.from('users')
                  .update({ pushsubscription: null, pushenabled: false })
                  .eq('userId', recipientId)
                  .then(({ error: deleteSubError }) => {
                    if (deleteSubError) console.error('만료된 구독 정보 삭제 실패:', deleteSubError);
                    else console.log(`✅ 만료된 구독 정보 삭제 완료: ${recipientId}`);
                  });
              }
            });
        } else {
          console.log(`수신자 ${recipientId}가 알림을 꺼뒀거나 구독 정보가 없음 / Recipiente ${recipientId} tiene notificaciones desactivadas o no hay información de suscripción`);
        }
      } catch (pushError) {
        console.error('푸시 알림 처리 중 예외 발생:', pushError);
      }
    } else {
        console.warn('채팅방 ID에서 수신자를 찾을 수 없음:', roomId);
    }
  }
  // --- 푸시 알림 로직 끝 ---
  
  res.json({ success: true, message: insertedMessage }); // 변수명 일치시킴
});

app.post('/upload', verifyUser, upload.single('file'), async (req, res) => {
  console.log('--- /upload 요청 처리 시작 ---');
  console.log('req.body 내용:', req.body);
  
  const { roomId, from } = req.body;
  console.log('추출 시도 후 roomId:', roomId);
  console.log('추출 시도 후 from:', from);
  
  // 필수 데이터 유효성 검사
  if (!roomId || !from) {
    console.error('roomId 또는 from 값이 없음:', { roomId, from });
    return res.status(400).json({ success: false, message: 'roomId와 from 값이 필요합니다' });
  }
  
  if (!req.file) {
    console.error('업로드된 파일이 없음');
    return res.status(400).json({ success: false, message: '파일이 필요합니다' });
  }
  
  if (from !== req.userId) {
    return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  }
  
  try {
    // 원본 파일명에서 확장자만 추출
    const originalName = req.file.originalname;
    const extension = originalName.split('.').pop() || 'dat'; // 확장자 추출 (없으면 'dat' 기본값 사용)
    
    // 안전한 파일명 생성 (타임스탬프 + 확장자만 사용)
    const fileName = `${Date.now()}.${extension}`;
    
    console.log('원본 파일 이름:', originalName);
    console.log('저장될 안전한 파일 이름:', fileName);
    
    // 파일 업로드 처리
    const { error: uploadError } = await supabase.storage.from('uploads').upload(fileName, req.file.buffer, {
      contentType: req.file.mimetype,
    });
    
    if (uploadError) {
      console.log('파일 업로드 에러 / Error al subir archivo:', uploadError);
      return res.status(500).json({ 
        success: false, 
        message: uploadError.error === 'InvalidKey' ? 
          '파일 이름 문제로 업로드 실패했습니다.' : 
          '파일 업로드 실패'
      });
    }
    
    // 파일 URL 가져오기
    const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(fileName);
    const fileUrl = urlData.publicUrl;
    
    // 메시지 데이터 준비 및 DB 저장
    const fileType = req.file.mimetype.startsWith('image') ? 'image' : 
                    (req.file.mimetype.startsWith('video') ? 'video' : 'file');
    
    const messageData = { 
      room: roomId, 
      from, 
      message: fileUrl, 
      type: fileType, 
      timestamp: new Date(), 
      read: false 
    };
    
    console.log('저장할 메시지 데이터:', messageData);
    
    const { data, error } = await supabase.from('messages').insert(messageData).select().single();
    
    if (error) {
      console.log('메시지 삽입 에러 / Error al insertar mensaje:', error);
      return res.status(500).json({ success: false, message: '메시지 저장 실패' });
    }
    
    console.log('파일 업로드 및 메시지 저장 성공');
    res.json({ success: true, message: data });
  } catch (error) {
    console.error('파일 업로드 처리 중 예외 발생:', error);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다' });
  }
});

app.post('/upload/profile', verifyUser, upload.single('profile'), async (req, res) => {
  const { userId } = req.body;

  if (!userId || !req.file) {
    console.log('입력값 오류 / Error de entrada:', { userId, file: req.file });
    return res.status(400).json({ success: false, message: 'userId나 파일이 없어요 / Falta userId o archivo' });
  }
  if (userId !== req.userId) {
    console.log('권한 오류 / Error de permiso:', { userId, reqUserId: req.userId });
    return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  }

  try {
    const { data: userData, error: userError } = await supabase.from('users').select('profilePic').eq('userId', userId).single();
    if (userError || !userData) {
      console.log('프로필 사진 조회 실패 / Fallo al obtener foto de perfil:', userError);
      return res.status(500).json({ success: false, message: '프로필 정보를 가져오지 못했어요 / No se pudo obtener la info del perfil' });
    }

    const oldProfilePic = userData.profilePic || '/uploads/default-profile.png';
    const isDefaultPic = oldProfilePic === '/uploads/default-profile.png';

    // 안전한 파일명 생성 (타임스탬프만 사용, 확장자는 jpg로 고정)
    const fileName = `profile-${Date.now()}.jpg`;
    console.log('프로필용 안전한 파일 이름:', fileName);
    
    const { error: uploadError } = await supabase.storage.from('uploads').upload(fileName, req.file.buffer, {
      contentType: req.file.mimetype,
    });
    if (uploadError) {
      console.log('프로필 사진 업로드 에러 / Error al subir foto de perfil:', uploadError);
      return res.status(500).json({ success: false, message: `사진 업로드에 실패했어요: ${uploadError.message} / Falló la subida de la foto: ${uploadError.message}` });
    }
    const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(fileName);
    const fileUrl = urlData.publicUrl;

    const { error: updateError } = await supabase.from('users').update({ profilePic: fileUrl }).eq('userId', userId);
    if (updateError) {
      console.log('프로필 업데이트 실패 / Fallo al actualizar perfil:', updateError);
      return res.status(500).json({ success: false, message: `프로필 업데이트에 실패했어요: ${updateError.message} / Falló la actualización del perfil: ${updateError.message}` });
    }

    if (!isDefaultPic) {
      const oldFileName = oldProfilePic.split('/').pop();
      const { error: deleteError } = await supabase.storage.from('uploads').remove([oldFileName]);
      if (deleteError) {
        console.log('이전 사진 삭제 실패 (무시됨) / Fallo al eliminar foto antigua (ignorado):', deleteError);
      }
    }

    res.json({ success: true, profilePic: fileUrl });
  } catch (error) {
    console.log('예상치 못한 오류 / Error inesperado:', error);
    res.status(500).json({ success: false, message: `알 수 없는 오류가 발생했어요: ${error.message} / Ocurrió un error desconocido: ${error.message}` });
  }
});

app.post('/upload/voice', verifyUser, upload.single('voice'), async (req, res) => {
  const { roomId, from } = req.body;
  if (!roomId || !from || !req.file) return res.status(400).json({ success: false });
  if (from !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  
  try {
    // 안전한 파일명 생성 (타임스탬프만 사용)
    const fileName = `${Date.now()}-voice.wav`;
    console.log('음성 메시지용 안전한 파일 이름:', fileName);
    
    const { error: uploadError } = await supabase.storage.from('uploads').upload(fileName, req.file.buffer, {
      contentType: 'audio/wav',
    });
    
    if (uploadError) {
      console.log('음성 업로드 에러 / Error al subir audio:', uploadError);
      return res.status(500).json({ success: false, message: '음성 메시지 업로드 실패' });
    }
    
    const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(fileName);
    const fileUrl = urlData.publicUrl;
    const messageData = { room: roomId, from, message: fileUrl, type: 'voice', timestamp: new Date(), read: false };
    const { data, error } = await supabase.from('messages').insert(messageData).select().single();
    
    if (error) {
      console.log('음성 메시지 삽입 에러 / Error al insertar mensaje de voz:', error);
      return res.status(500).json({ success: false });
    }
    
    console.log('음성 메시지 업로드 및 저장 성공');
    res.json({ success: true, message: data });
  } catch (error) {
    console.error('음성 메시지 처리 중 예외 발생:', error);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다' });
  }
});

app.post('/chat/delete/:roomId/:userId', verifyUser, async (req, res) => {
  const roomId = req.params.roomId;
  const userId = req.params.userId;
  if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });

  // 삭제 시점 타임스탬프 생성
  const deleteTimestamp = new Date().toISOString();
  console.log(`채팅 삭제 요청: roomId=${roomId}, userId=${userId}, 시점=${deleteTimestamp}`);

  // 삭제 시점 이전의 메시지만 가져오기
  const { data: messages, error: msgError } = await supabase
    .from('messages')
    .select('id')
    .eq('room', roomId)
    .lt('timestamp', deleteTimestamp); // 삭제 시점 이전 메시지만
  
  if (msgError) {
    console.log('채팅 삭제 - 메시지 가져오기 에러 / Error al obtener mensajes para eliminar chat:', msgError);
    return res.status(500).json({ success: false, message: '메시지 가져오기 실패 / Error al obtener mensajes' });
  }

  if (!messages || messages.length === 0) {
    console.log('삭제할 메시지가 없음 / No hay mensajes para eliminar', { roomId, userId });
    return res.json({ success: true, message: '삭제할 메시지가 없음 / No hay mensajes para eliminar', timestamp: deleteTimestamp });
  }

  // 기존 삭제 기록 제거 (같은 채팅방, 같은 사용자에 대해)
  const { error: deleteOldError } = await supabase
    .from('deleted_messages')
    .delete()
    .eq('userId', userId)
    .eq('roomId', roomId);
  
  if (deleteOldError) {
    console.log('기존 삭제 기록 제거 실패 / Error al eliminar registros antiguos:', deleteOldError);
    // 계속 진행 (중요하지 않은 오류)
  }

  // 각 메시지 ID와 함께 삭제 시점 타임스탬프 저장
  const deletedEntries = messages.map(m => ({
    userId,
    roomId,
    messageId: m.id,
    timestamp: deleteTimestamp // 삭제 시점 저장
  }));
  
  const { error: insertError } = await supabase.from('deleted_messages').insert(deletedEntries);
  if (insertError) {
    console.log('채팅 삭제 - 삽입 에러 / Error al insertar eliminación de chat:', insertError);
    return res.status(500).json({ success: false, message: '삭제 기록 삽입 실패 / Error al insertar registro de eliminación' });
  }

  console.log('삭제 기록 삽입 성공 / Registro de eliminación insertado', { roomId, userId, count: deletedEntries.length, timestamp: deleteTimestamp });
  res.json({ success: true, timestamp: deleteTimestamp });
});

// Monera Endpoints
app.get('/monera/:userId', verifyUser, async (req, res) => {
  const userId = req.params.userId;
  if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  
  try {
    const { data, error } = await supabase.from('users').select('monera').eq('userId', userId).single();
    if (error) {
      console.log('모네라 정보 가져오기 에러 / Error al obtener información de monera:', error);
      return res.status(500).json({ success: false, message: '서버 에러 / Error del servidor' });
    }
    
    // If monera field doesn't exist or is null, initialize it
    const monera = data.monera || 0;
    if (!data.monera) {
      // Update the user with initial monera value
      const { error: updateError } = await supabase.from('users').update({ monera: 0 }).eq('userId', userId);
      if (updateError) {
        console.log('모네라 초기화 에러 / Error al inicializar monera:', updateError);
      }
    }
    
    res.json({ success: true, monera });
  } catch (error) {
    console.log('모네라 정보 처리 중 에러 / Error al procesar información de monera:', error);
    res.status(500).json({ success: false, message: '서버 에러 / Error del servidor' });
  }
});

app.post('/monera/earn', verifyUser, async (req, res) => {
  const { userId, amount } = req.body;
  if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  
  try {
    // Get current monera
    const { data, error } = await supabase.from('users').select('monera').eq('userId', userId).single();
    if (error) {
      console.log('모네라 정보 가져오기 에러 / Error al obtener información de monera:', error);
      return res.status(500).json({ success: false, message: '서버 에러 / Error del servidor' });
    }
    
    // Calculate new monera amount
    const currentMonera = data.monera || 0;
    const newMonera = currentMonera + amount;
    
    // Update monera
    const { error: updateError } = await supabase.from('users').update({ monera: newMonera }).eq('userId', userId);
    if (updateError) {
      console.log('모네라 업데이트 에러 / Error al actualizar monera:', updateError);
      return res.status(500).json({ success: false, message: '모네라 업데이트 실패 / Error al actualizar monera' });
    }
    
    res.json({ success: true, monera: newMonera });
  } catch (error) {
    console.log('모네라 획득 처리 중 에러 / Error al procesar ganancia de monera:', error);
    res.status(500).json({ success: false, message: '서버 에러 / Error del servidor' });
  }
});

app.post('/monera/spend', verifyUser, async (req, res) => {
  const { userId, amount } = req.body;
  if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  
  try {
    // Get current monera
    const { data, error } = await supabase.from('users').select('monera').eq('userId', userId).single();
    if (error) {
      console.log('모네라 정보 가져오기 에러 / Error al obtener información de monera:', error);
      return res.status(500).json({ success: false, message: '서버 에러 / Error del servidor' });
    }
    
    // Check if user has enough monera
    const currentMonera = data.monera || 0;
    if (currentMonera < amount) {
      return res.status(400).json({ success: false, message: '모네라가 부족해요 / No tienes suficiente monera' });
    }
    
    // Calculate new monera amount
    const newMonera = currentMonera - amount;
    
    // Update monera
    const { error: updateError } = await supabase.from('users').update({ monera: newMonera }).eq('userId', userId);
    if (updateError) {
      console.log('모네라 업데이트 에러 / Error al actualizar monera:', updateError);
      return res.status(500).json({ success: false, message: '모네라 업데이트 실패 / Error al actualizar monera' });
    }
    
    res.json({ success: true, monera: newMonera });
  } catch (error) {
    console.log('모네라 사용 처리 중 에러 / Error al procesar uso de monera:', error);
    res.status(500).json({ success: false, message: '서버 에러 / Error del servidor' });
  }
});

app.post('/monera/transfer', verifyUser, async (req, res) => {
  const { fromUserId, toUserId, amount } = req.body;
  if (fromUserId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  
  // Start a transaction
  try {
    // Get sender's monera
    const { data: senderData, error: senderError } = await supabase
      .from('users')
      .select('monera')
      .eq('userId', fromUserId)
      .single();
    
    if (senderError) {
      console.log('보내는 사람 모네라 정보 가져오기 에러 / Error al obtener información de monera del remitente:', senderError);
      return res.status(500).json({ success: false, message: '서버 에러 / Error del servidor' });
    }
    
    // Check if sender has enough monera
    const senderMonera = senderData.monera || 0;
    if (senderMonera < amount) {
      return res.status(400).json({ success: false, message: '모네라가 부족해요 / No tienes suficiente monera' });
    }
    
    // Get receiver's monera
    const { data: receiverData, error: receiverError } = await supabase
      .from('users')
      .select('monera')
      .eq('userId', toUserId)
      .single();
    
    if (receiverError) {
      console.log('받는 사람 모네라 정보 가져오기 에러 / Error al obtener información de monera del destinatario:', receiverError);
      return res.status(500).json({ success: false, message: '받는 사람을 찾을 수 없어요 / No se puede encontrar al destinatario' });
    }
    
    // Calculate new monera amounts
    const newSenderMonera = senderMonera - amount;
    const receiverMonera = receiverData.monera || 0;
    const newReceiverMonera = receiverMonera + amount;
    
    // Update sender's monera
    const { error: senderUpdateError } = await supabase
      .from('users')
      .update({ monera: newSenderMonera })
      .eq('userId', fromUserId);
    
    if (senderUpdateError) {
      console.log('보내는 사람 모네라 업데이트 에러 / Error al actualizar monera del remitente:', senderUpdateError);
      return res.status(500).json({ success: false, message: '모네라 전송 실패 / Error al transferir monera' });
    }
    
    // Update receiver's monera
    const { error: receiverUpdateError } = await supabase
      .from('users')
      .update({ monera: newReceiverMonera })
      .eq('userId', toUserId);
    
    if (receiverUpdateError) {
      console.log('받는 사람 모네라 업데이트 에러 / Error al actualizar monera del destinatario:', receiverUpdateError);
      // Rollback sender's monera if receiver update fails
      await supabase.from('users').update({ monera: senderMonera }).eq('userId', fromUserId);
      return res.status(500).json({ success: false, message: '모네라 전송 실패 / Error al transferir monera' });
    }
    
    res.json({ success: true, monera: newSenderMonera });
  } catch (error) {
    console.log('모네라 전송 처리 중 에러 / Error al procesar transferencia de monera:', error);
    res.status(500).json({ success: false, message: '서버 에러 / Error del servidor' });
  }
});

app.post('/monera/admin/add', verifyUser, async (req, res) => {
  const { userId, amount } = req.body;
  if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  
  try {
    // Get current monera
    const { data, error } = await supabase.from('users').select('monera').eq('userId', userId).single();
    if (error) {
      console.log('관리자 모네라 정보 가져오기 에러 / Error al obtener información de monera del administrador:', error);
      return res.status(500).json({ success: false, message: '서버 에러 / Error del servidor' });
    }
    
    // Calculate new monera amount
    const currentMonera = data.monera || 0;
    const newMonera = currentMonera + amount;
    
    // Update monera
    const { error: updateError } = await supabase.from('users').update({ monera: newMonera }).eq('userId', userId);
    if (updateError) {
      console.log('관리자 모네라 업데이트 에러 / Error al actualizar monera del administrador:', updateError);
      return res.status(500).json({ success: false, message: '모네라 업데이트 실패 / Error al actualizar monera' });
    }
    
    res.json({ success: true, monera: newMonera });
  } catch (error) {
    console.log('관리자 모네라 추가 처리 중 에러 / Error al procesar adición de monera por administrador:', error);
    res.status(500).json({ success: false, message: '서버 에러 / Error del servidor' });
  }
});

app.get('/monera/friend/:userId/:friendId', verifyUser, async (req, res) => {
  const userId = req.params.userId;
  const friendId = req.params.friendId;
  if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });
  
  try {
    // Check if they are friends
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('friends')
      .eq('userId', userId)
      .single();
      
    if (userError || !userData.friends.includes(friendId)) {
      return res.status(403).json({ success: false, message: '친구가 아니에요 / No es tu amigo' });
    }
    
    // Get friend's Monera
    const { data: friendData, error: friendError } = await supabase
      .from('users')
      .select('monera')
      .eq('userId', friendId)
      .single();
      
    if (friendError) {
      console.log('친구 모네라 정보 가져오기 에러 / Error al obtener información de monera del amigo:', friendError);
      return res.status(500).json({ success: false, message: '서버 에러 / Error del servidor' });
    }
    
    res.json({ success: true, monera: friendData.monera || 0 });
  } catch (error) {
    console.log('친구 모네라 정보 처리 중 에러 / Error al procesar información de monera del amigo:', error);
    res.status(500).json({ success: false, message: '서버 에러 / Error del servidor' });
  }
});

// VAPID 공개 키를 클라이언트에 전달하는 엔드포인트
app.get('/vapidPublicKey', (req, res) => {
  if (!vapidPublicKey) {
     return res.status(500).json({ error: 'VAPID 공개 키가 설정되지 않았습니다.' });
  }
  res.send(vapidPublicKey);
});

// 사용자 푸시 활성화 상태 가져오는 엔드포인트
app.get('/user-push-status/:userId', verifyUser, async (req, res) => {
    const userId = req.params.userId;
    if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한 없음' });
    
    try {
        const { data, error } = await supabase.from('users').select('pushenabled').eq('userId', userId).single();
        if (error && error.code !== 'PGRST116') { // 레코드 없음 외의 에러
            console.error('푸시 상태 조회 에러:', error);
            return res.status(500).json({ success: false, message: '서버 에러' });
        }
        // 사용자가 없거나 pushenabled 컬럼이 없는 경우 false 반환
        res.json({ success: true, pushEnabled: data?.pushenabled || false });
    } catch (error) {
         console.error('푸시 상태 조회 중 예외 발생:', error);
         res.status(500).json({ success: false, message: '서버 에러' });
    }
});

// 사용자 푸시 활성화 상태 업데이트 엔드포인트
app.post('/update-push-status', verifyUser, async (req, res) => {
    const { userId, enabled } = req.body;
    if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한 없음' });

    try {
        const { error } = await supabase.from('users').update({ pushenabled: enabled }).eq('userId', userId);
        if (error) {
             console.error('푸시 상태 업데이트 에러:', error);
             return res.status(500).json({ success: false, message: '상태 업데이트 실패' });
        }
        res.json({ success: true });
    } catch (error) {
         console.error('푸시 상태 업데이트 중 예외 발생:', error);
         res.status(500).json({ success: false, message: '서버 에러' });
    }
});

// 구독 정보 저장 엔드포인트
app.post('/save-subscription', verifyUser, async (req, res) => {
  const { userId, subscription } = req.body;
  if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한이 없어요 / No tienes permiso' });

  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ success: false, message: '잘못된 구독 정보 / Información de suscripción inválida' });
  }

  try {
    // 이미 구독 정보가 있는지 확인 (endpoint 기준으로, 더 정확하게 하려면 다른 필드도 확인 가능)
    const { data: existingUser, error: selectError } = await supabase
        .from('users')
        .select('pushsubscription')
        .eq('userId', userId)
        .single();

    if (selectError && selectError.code !== 'PGRST116') { // 레코드 없음 외의 에러
        console.error('기존 구독 정보 조회 에러:', selectError);
        return res.status(500).json({ success: false, message: '서버 에러' });
    }
    
    // Supabase에 구독 정보와 pushenabled=true 저장
    const { error: updateError } = await supabase
      .from('users')
      .update({ pushsubscription: subscription, pushenabled: true }) 
      .eq('userId', userId);

    if (updateError) {
      console.error('Supabase 구독 정보 저장/업데이트 에러:', updateError);
      return res.status(500).json({ success: false, message: '구독 정보 저장 실패 / Error al guardar suscripción' });
    }

    console.log(`🔔 푸시 알림 활성화: ${userId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('구독 정보 저장 중 예외 발생:', error);
    res.status(500).json({ success: false, message: '서버 에러 / Error del servidor' });
  }
});

// 구독 정보 삭제 엔드포인트
app.post('/delete-subscription', verifyUser, async (req, res) => {
    const { userId } = req.body;
    if (userId !== req.userId) return res.status(403).json({ success: false, message: '권한 없음' });

    try {
        // 구독 정보와 pushenabled=false 업데이트
        const { error } = await supabase
            .from('users')
            .update({ pushsubscription: null, pushenabled: false }) 
            .eq('userId', userId);
        
        if (error) {
             console.error('구독 정보 삭제 에러:', error);
             return res.status(500).json({ success: false, message: '삭제 실패' });
        }
        console.log('구독 정보 삭제 성공 / Suscripción eliminada para:', userId);
        res.json({ success: true });
    } catch(error) {
         console.error('구독 정보 삭제 중 예외 발생:', error);
         res.status(500).json({ success: false, message: '서버 에러' });
    }
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`서버가 http://localhost:${process.env.PORT || 3000}에서 실행 중이야! / ¡El servidor está corriendo!`);
});