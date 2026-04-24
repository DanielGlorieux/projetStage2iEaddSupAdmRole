import { apiClient } from "./api";

export interface Message {
  id: string;
  content: string;
  isRead: boolean;
  createdAt: string;
  updatedAt: string;
  senderId: string;
  receiverId: string;
  sender: {
    id: string;
    name: string;
    email: string;
    role: string;
  };
  receiver: {
    id: string;
    name: string;
    email: string;
    role: string;
  };
}

export interface Conversation {
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
  };
  lastMessage: Message | null;
  unreadCount: number;
  messages: Message[];
}

export interface ChatContact {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface ChatSocketClient {
  socket: WebSocket;
  disconnect: () => void;
  sendMessage: (receiverId: string, content: string) => void;
  markConversationRead: (conversationUserId: string) => void;
}

const buildChatWsUrl = () => {
  const apiBaseUrl = import.meta.env.VITE_API_URL || "http://localhost:5000/api";
  const wsBaseUrl = apiBaseUrl
    .replace("http://", "ws://")
    .replace("https://", "wss://")
    .replace(/\/api$/, "");
  return `${wsBaseUrl}/ws/chat`;
};

export const messageService = {
  // Récupérer tous les messages
  async getMessages(limit = 50, offset = 0) {
    return apiClient.get<Message[]>(`/messages?limit=${limit}&offset=${offset}`);
  },

  // Récupérer la liste des conversations
  async getConversations() {
    return apiClient.get<Conversation[]>("/messages/conversations");
  },

  // Récupérer les utilisateurs contactables pour démarrer une conversation
  async getContacts(search?: string) {
    const query = search ? `?search=${encodeURIComponent(search)}` : "";
    return apiClient.get<ChatContact[]>(`/messages/contacts${query}`);
  },

  // Récupérer une conversation spécifique
  async getConversation(userId: string) {
    return apiClient.get<Message[]>(`/messages/conversation/${userId}`);
  },

  // Envoyer un message
  async sendMessage(receiverId: string, content: string) {
    return apiClient.post<Message>("/messages", { receiverId, content });
  },

  // Marquer un message comme lu
  async markAsRead(messageId: string) {
    return apiClient.put<Message>(`/messages/${messageId}/read`, {});
  },

  // Compter les messages non lus
  async getUnreadCount() {
    return apiClient.get<{ count: number }>("/messages/unread/count");
  },

  // Supprimer un message
  async deleteMessage(messageId: string) {
    return apiClient.delete(`/messages/${messageId}`);
  },

  connectToChatSocket(
    handlers: {
      onMessage?: (message: Message) => void;
      onUnreadCount?: (count: number) => void;
      onMessagesRead?: (readerId: string) => void;
      onConnected?: () => void;
      onError?: (error: string) => void;
    } = {}
  ): ChatSocketClient | null {
    const token = localStorage.getItem("token");
    if (!token) {
      return null;
    }

    const socket = new WebSocket(`${buildChatWsUrl()}?token=${encodeURIComponent(token)}`);

    socket.onopen = () => {
      handlers.onConnected?.();
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "new_message") {
          handlers.onMessage?.(data.payload as Message);
          return;
        }
        if (data.type === "unread_count_update") {
          handlers.onUnreadCount?.(Number(data.payload?.count || 0));
          return;
        }
        if (data.type === "messages_read") {
          handlers.onMessagesRead?.(String(data.payload?.readerId || ""));
          return;
        }
        if (data.type === "error") {
          handlers.onError?.(String(data.payload?.message || "Erreur chat temps réel"));
        }
      } catch {
        handlers.onError?.("Message temps réel invalide");
      }
    };

    socket.onerror = () => {
      handlers.onError?.("Connexion WebSocket indisponible");
    };

    return {
      socket,
      disconnect: () => {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      },
      sendMessage: (receiverId: string, content: string) => {
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }
        socket.send(
          JSON.stringify({
            type: "send_message",
            payload: { receiverId, content },
          })
        );
      },
      markConversationRead: (conversationUserId: string) => {
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }
        socket.send(
          JSON.stringify({
            type: "mark_read",
            payload: { conversationUserId },
          })
        );
      },
    };
  },
};
