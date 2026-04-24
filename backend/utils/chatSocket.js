const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || "votre_secret_jwt_très_sécurisé";

const userConnections = new Map();

const sendEvent = (ws, payload) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
};

const broadcastToUsers = (userIds, payload) => {
  userIds.forEach((userId) => {
    const sockets = userConnections.get(userId);
    if (!sockets) return;
    sockets.forEach((socket) => sendEvent(socket, payload));
  });
};

const attachUserConnection = (userId, ws) => {
  const sockets = userConnections.get(userId) || new Set();
  sockets.add(ws);
  userConnections.set(userId, sockets);
};

const detachUserConnection = (userId, ws) => {
  const sockets = userConnections.get(userId);
  if (!sockets) return;
  sockets.delete(ws);
  if (sockets.size === 0) {
    userConnections.delete(userId);
  }
};

const buildMessagePayload = async ({ senderId, receiverId, content }) => {
  return prisma.message.create({
    data: {
      senderId,
      receiverId,
      content,
    },
    include: {
      sender: {
        select: { id: true, name: true, email: true, role: true },
      },
      receiver: {
        select: { id: true, name: true, email: true, role: true },
      },
    },
  });
};

const emitUnreadCount = async (userId) => {
  const count = await prisma.message.count({
    where: {
      receiverId: userId,
      isRead: false,
    },
  });

  broadcastToUsers([userId], {
    type: "unread_count_update",
    payload: { count },
  });
};

const handleSendMessage = async ({ senderId, receiverId, content }) => {
  const message = await buildMessagePayload({ senderId, receiverId, content });
  broadcastToUsers([senderId, receiverId], {
    type: "new_message",
    payload: message,
  });
  await emitUnreadCount(receiverId);
  return message;
};

const handleMarkRead = async ({ userId, messageId, conversationUserId }) => {
  if (messageId) {
    await prisma.message.updateMany({
      where: {
        id: messageId,
        receiverId: userId,
        isRead: false,
      },
      data: {
        isRead: true,
      },
    });
  } else if (conversationUserId) {
    await prisma.message.updateMany({
      where: {
        senderId: conversationUserId,
        receiverId: userId,
        isRead: false,
      },
      data: {
        isRead: true,
      },
    });
    broadcastToUsers([conversationUserId], {
      type: "messages_read",
      payload: { readerId: userId },
    });
  }

  await emitUnreadCount(userId);
};

const initChatWebSocket = (server) => {
  const wss = new WebSocket.Server({ noServer: true });

  server.on("upgrade", async (request, socket, head) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname !== "/ws/chat") {
        socket.destroy();
        return;
      }

      const token = url.searchParams.get("token");
      if (!token) {
        socket.destroy();
        return;
      }

      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, email: true, name: true, role: true },
      });

      if (!user) {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request, user);
      });
    } catch {
      socket.destroy();
    }
  });

  wss.on("connection", (ws, _request, user) => {
    const userId = user.id;
    attachUserConnection(userId, ws);

    sendEvent(ws, {
      type: "connection_established",
      payload: { userId },
    });

    ws.on("message", async (rawMessage) => {
      try {
        const parsed = JSON.parse(rawMessage.toString());
        if (!parsed?.type) {
          return;
        }

        if (parsed.type === "send_message") {
          const receiverId = String(parsed.payload?.receiverId || "");
          const content = String(parsed.payload?.content || "").trim();
          if (!receiverId || !content) {
            sendEvent(ws, {
              type: "error",
              payload: { message: "Données de message invalides." },
            });
            return;
          }

          const receiverExists = await prisma.user.findUnique({
            where: { id: receiverId },
            select: { id: true },
          });
          if (!receiverExists) {
            sendEvent(ws, {
              type: "error",
              payload: { message: "Destinataire non trouvé." },
            });
            return;
          }

          await handleSendMessage({ senderId: userId, receiverId, content });
          return;
        }

        if (parsed.type === "mark_read") {
          await handleMarkRead({
            userId,
            messageId: parsed.payload?.messageId,
            conversationUserId: parsed.payload?.conversationUserId,
          });
        }
      } catch {
        sendEvent(ws, {
          type: "error",
          payload: { message: "Message WebSocket invalide." },
        });
      }
    });

    ws.on("close", () => {
      detachUserConnection(userId, ws);
    });
  });

  return {
    notifyNewMessage: async (message) => {
      broadcastToUsers([message.senderId, message.receiverId], {
        type: "new_message",
        payload: message,
      });
      await emitUnreadCount(message.receiverId);
    },
    notifyMessagesRead: async ({ readerId, conversationUserId }) => {
      broadcastToUsers([conversationUserId], {
        type: "messages_read",
        payload: { readerId },
      });
      await emitUnreadCount(readerId);
    },
  };
};

module.exports = {
  initChatWebSocket,
};
