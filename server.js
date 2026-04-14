// signaling-server/server.js
// WebRTC Signaling Server using Socket.io
// Run: node server.js
 
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

// ✅ Allowed domain (IMPORTANT)
const allowedOrigins = [
  "https://skills.vtudeveloper.in"
];

// ✅ Express CORS
app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

app.use(express.json());

const server = http.createServer(app);

// ✅ Socket.io CORS
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  }
});
 
const PORT = process.env.PORT || 3000;
 
// Room state
const rooms = {};
const participants = {}; // socketId -> participant info
 
// ─── REST endpoint: class status check ───────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'VTUDeveloper Signaling Server Running' }));
 
// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);
 
  // ── Join Room ──────────────────────────────────────────────────────────────
  socket.on('join-room', ({ roomId, userId, userName, role, isMuted, isCameraOff }) => {
    socket.join(roomId);
 
    const participant = {
      socketId: socket.id,
      userId,
      userName,
      role,
      roomId,
      isMuted: isMuted || false,
      isCameraOff: isCameraOff || false,
      isHandRaised: false,
      joinedAt: new Date().toISOString()
    };
 
    participants[socket.id] = participant;
 
    if (!rooms[roomId]) rooms[roomId] = {};
    rooms[roomId][socket.id] = participant;
 
    // Notify existing participants about new user
    socket.to(roomId).emit('user-joined', participant);
 
    // Send existing participants to the new user
    const existingParticipants = Object.values(rooms[roomId]).filter(p => p.socketId !== socket.id);
    socket.emit('existing-participants', existingParticipants);
 
    // Send room info to new user
    socket.emit('room-joined', { roomId, participant, participantCount: Object.keys(rooms[roomId]).length });
 
    console.log(`[Room ${roomId}] ${userName} (${role}) joined. Total: ${Object.keys(rooms[roomId]).length}`);
  });
 
  // ── WebRTC Signaling ───────────────────────────────────────────────────────
  socket.on('offer', ({ targetSocketId, offer, fromSocketId }) => {
    io.to(targetSocketId).emit('offer', { offer, fromSocketId });
  });
 
  socket.on('answer', ({ targetSocketId, answer, fromSocketId }) => {
    io.to(targetSocketId).emit('answer', { answer, fromSocketId });
  });
 
  socket.on('ice-candidate', ({ targetSocketId, candidate, fromSocketId }) => {
    io.to(targetSocketId).emit('ice-candidate', { candidate, fromSocketId });
  });
 
  // ── Chat Messages ──────────────────────────────────────────────────────────
  socket.on('chat-message', ({ roomId, message, senderName, senderId, senderRole, targetId }) => {
    const participant = participants[socket.id];
    if (!participant) return;
 
    const msgData = {
      id: Date.now(),
      message,
      senderName,
      senderId,
      senderRole,
      timestamp: new Date().toISOString(),
      isPrivate: !!targetId
    };
 
    if (senderRole === 'admin') {
      // Admin message broadcasts to all or specific student
      if (targetId) {
        const targetSocket = Object.values(participants).find(p => p.userId === targetId);
        if (targetSocket) {
          io.to(targetSocket.socketId).emit('chat-message', msgData);
          socket.emit('chat-message', { ...msgData, isOwnMessage: true });
        }
      } else {
        io.in(roomId).emit('chat-message', msgData);
      }
    } else {
      // Student message only goes to admin
      const adminSocket = Object.values(participants).find(p => p.role === 'admin' && p.roomId === roomId);
      if (adminSocket) {
        io.to(adminSocket.socketId).emit('chat-message', { ...msgData, fromStudentId: senderId });
      }
      socket.emit('chat-message', { ...msgData, isOwnMessage: true });
    }
  });
 
  // ── Admin Controls ─────────────────────────────────────────────────────────
  socket.on('admin-mute-all', ({ roomId }) => {
    socket.to(roomId).emit('force-mute', { target: 'all' });
    updateAllParticipantsMuted(roomId, true);
  });
 
  socket.on('admin-mute-student', ({ roomId, targetSocketId, muted }) => {
    io.to(targetSocketId).emit('force-mute', { target: targetSocketId, muted });
    if (participants[targetSocketId]) {
      participants[targetSocketId].isMuted = muted;
      rooms[roomId][targetSocketId].isMuted = muted;
    }
    io.in(roomId).emit('participant-updated', { socketId: targetSocketId, isMuted: muted });
  });
 
  socket.on('admin-disable-camera', ({ roomId, targetSocketId, disabled }) => {
    io.to(targetSocketId).emit('force-camera-off', { disabled });
    if (participants[targetSocketId]) {
      participants[targetSocketId].isCameraOff = disabled;
      rooms[roomId][targetSocketId].isCameraOff = disabled;
    }
    io.in(roomId).emit('participant-updated', { socketId: targetSocketId, isCameraOff: disabled });
  });
 
  socket.on('admin-remove-student', ({ roomId, targetSocketId }) => {
    io.to(targetSocketId).emit('removed-from-class');
    const target = io.sockets.sockets.get(targetSocketId);
    if (target) target.leave(roomId);
    cleanupParticipant(targetSocketId, roomId);
    io.in(roomId).emit('user-left', { socketId: targetSocketId });
  });
 
  socket.on('admin-disable-chat', ({ roomId, disabled }) => {
    socket.to(roomId).emit('chat-disabled', { disabled });
  });
 
  socket.on('admin-end-class', ({ roomId }) => {
    io.in(roomId).emit('class-ended');
    if (rooms[roomId]) delete rooms[roomId];
  });
 
  // ── Media State Updates ────────────────────────────────────────────────────
  socket.on('media-state-change', ({ roomId, isMuted, isCameraOff, isScreenSharing }) => {
    if (participants[socket.id]) {
      participants[socket.id].isMuted = isMuted;
      participants[socket.id].isCameraOff = isCameraOff;
      participants[socket.id].isScreenSharing = isScreenSharing;
      if (rooms[roomId] && rooms[roomId][socket.id]) {
        rooms[roomId][socket.id] = { ...rooms[roomId][socket.id], isMuted, isCameraOff, isScreenSharing };
      }
    }
    socket.to(roomId).emit('participant-updated', {
      socketId: socket.id,
      isMuted,
      isCameraOff,
      isScreenSharing
    });
  });
 
  // ── Screen Share ───────────────────────────────────────────────────────────
  socket.on('screen-share-started', ({ roomId }) => {
    socket.to(roomId).emit('screen-share-started', { socketId: socket.id });
  });
 
  socket.on('screen-share-stopped', ({ roomId }) => {
    socket.to(roomId).emit('screen-share-stopped', { socketId: socket.id });
  });
 
  // ── Raise Hand ────────────────────────────────────────────────────────────
  socket.on('raise-hand', ({ roomId, raised }) => {
    if (participants[socket.id]) {
      participants[socket.id].isHandRaised = raised;
    }
    io.in(roomId).emit('hand-raised', { socketId: socket.id, userName: participants[socket.id]?.userName, raised });
  });
 
  // ── Speaking indicator ────────────────────────────────────────────────────
  socket.on('speaking', ({ roomId, isSpeaking }) => {
    socket.to(roomId).emit('user-speaking', { socketId: socket.id, isSpeaking });
  });
 
  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const participant = participants[socket.id];
    if (participant) {
      const { roomId, userName } = participant;
      console.log(`[-] Disconnected: ${userName} from room ${roomId}`);
      cleanupParticipant(socket.id, roomId);
      if (roomId) io.in(roomId).emit('user-left', { socketId: socket.id, userName });
    }
  });
});
 
function cleanupParticipant(socketId, roomId) {
  delete participants[socketId];
  if (roomId && rooms[roomId]) {
    delete rooms[roomId][socketId];
    if (Object.keys(rooms[roomId]).length === 0) delete rooms[roomId];
  }
}
 
function updateAllParticipantsMuted(roomId, muted) {
  if (rooms[roomId]) {
    Object.keys(rooms[roomId]).forEach(sid => {
      if (participants[sid]) participants[sid].isMuted = muted;
      rooms[roomId][sid].isMuted = muted;
    });
    io.in(roomId).emit('all-participants-updated', { isMuted: muted });
  }
}
 
server.listen(PORT, () => {
  console.log(`\n🚀 VTUDeveloper Signaling Server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
