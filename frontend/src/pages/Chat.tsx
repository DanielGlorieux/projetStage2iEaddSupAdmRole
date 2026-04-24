import React, { useState, useEffect, useRef } from "react";
import {
  messageService,
  type Message,
  type Conversation,
  type ChatContact,
  type ChatSocketClient,
} from "../services/messageService";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ScrollArea } from "../components/ui/scroll-area";
import { Avatar, AvatarFallback } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Send, MessageCircle, Trash2, Search } from "lucide-react";
import { toast } from "sonner";

export function Chat() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [contacts, setContacts] = useState<ChatContact[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [loadingContacts, setLoadingContacts] = useState(true);
  const currentUserId = JSON.parse(localStorage.getItem("user") || "{}").id;
  const socketClientRef = useRef<ChatSocketClient | null>(null);
  const selectedConversationIdRef = useRef<string | null>(null);

  useEffect(() => {
    loadConversations();
    loadContacts();

    socketClientRef.current = messageService.connectToChatSocket({
      onMessage: async (message) => {
        const otherUserId =
          message.senderId === currentUserId ? message.receiverId : message.senderId;

        setConversations((prev) => {
          const existing = prev.find((conversation) => conversation.user.id === otherUserId);
          const unreadIncrement =
            message.receiverId === currentUserId &&
            selectedConversationIdRef.current !== otherUserId
              ? 1
              : 0;

          const updatedConversation: Conversation = existing
            ? {
                ...existing,
                lastMessage: message,
                unreadCount: existing.unreadCount + unreadIncrement,
                messages: [message, ...(existing.messages || [])],
              }
            : {
                user: message.senderId === currentUserId ? message.receiver : message.sender,
                lastMessage: message,
                unreadCount: unreadIncrement,
                messages: [message],
              };

          const next = [
            updatedConversation,
            ...prev.filter((conversation) => conversation.user.id !== otherUserId),
          ];
          return next;
        });

        if (selectedConversationIdRef.current === otherUserId) {
          setMessages((prev) =>
            prev.some((item) => item.id === message.id) ? prev : [...prev, message]
          );

          if (message.receiverId === currentUserId) {
            await messageService.markAsRead(message.id);
            socketClientRef.current?.markConversationRead(otherUserId);
          }
        }
      },
      onUnreadCount: () => {
        loadConversations();
      },
      onError: (error) => {
        console.error(error);
      },
    });

    return () => {
      socketClientRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    selectedConversationIdRef.current = selectedConversation?.user.id || null;
  }, [selectedConversation]);

  const loadConversations = async () => {
    setLoading(true);
    const response = await messageService.getConversations();
    if (response.success && response.data) {
      setConversations(response.data);
      setSelectedConversation((prev) => {
        if (!prev) return null;
        return response.data?.find((conversation) => conversation.user.id === prev.user.id) || prev;
      });
    }
    setLoading(false);
  };

  const loadContacts = async () => {
    setLoadingContacts(true);
    const response = await messageService.getContacts();
    if (response.success && response.data) {
      setContacts(response.data);
    }
    setLoadingContacts(false);
  };

  const loadConversation = async (
    userId: string,
    user?: Conversation["user"] | ChatContact
  ) => {
    if (user) {
      setConversations((prev) => {
        const existing = prev.find((conversation) => conversation.user.id === userId);
        if (existing) return prev;
        return [{ user, lastMessage: null, unreadCount: 0, messages: [] }, ...prev];
      });
      setSelectedConversation((prev) =>
        prev?.user.id === userId
          ? prev
          : { user, lastMessage: null, unreadCount: 0, messages: [] }
      );
    }

    const response = await messageService.getConversation(userId);
    if (response.success && response.data) {
      setMessages(response.data);
      const latestMessage = response.data[response.data.length - 1] || null;
      const fallbackUser = user || selectedConversation?.user;
      if (fallbackUser) {
        setSelectedConversation({
          user: fallbackUser,
          lastMessage: latestMessage,
          unreadCount: 0,
          messages: response.data,
        });
      }
      setConversations((prev) => {
        const existing = prev.find((conversation) => conversation.user.id === userId);
        const resolvedUser =
          existing?.user ||
          user ||
          prev.find((conversation) => conversation.user.id === userId)?.user ||
          (selectedConversation?.user.id === userId ? selectedConversation.user : null);

        if (!resolvedUser) {
          return prev;
        }

        const updatedConversation: Conversation = {
          user: resolvedUser,
          lastMessage: latestMessage,
          unreadCount: 0,
          messages: response.data,
        };

        return [
          updatedConversation,
          ...prev.filter((conversation) => conversation.user.id !== userId),
        ];
      });
      socketClientRef.current?.markConversationRead(userId);
    }
  };

  const handleSendMessage = async () => {
    if (!newMessage.trim() || !selectedConversation) return;

    setSending(true);
    const content = newMessage.trim();
    const socketClient = socketClientRef.current;

    if (socketClient && socketClient.socket.readyState === WebSocket.OPEN) {
      socketClient.sendMessage(selectedConversation.user.id, content);
      setNewMessage("");
      toast.success("Message envoyé");
    } else {
      const response = await messageService.sendMessage(
        selectedConversation.user.id,
        content
      );
      if (response.success && response.data) {
        setMessages([...messages, response.data]);
        setNewMessage("");
        toast.success("Message envoyé");
      } else {
        toast.error("Erreur d'envoi du message");
      }
    }
    setSending(false);
  };

  const handleDeleteMessage = async (messageId: string) => {
    const response = await messageService.deleteMessage(messageId);
    if (response.success) {
      setMessages(messages.filter((m) => m.id !== messageId));
      toast.success("Message supprimé");
    }
  };

  const filteredConversations = conversations.filter((conv) =>
    conv.user.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    conv.user.email.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const filteredContacts = contacts.filter((contact) => {
    const alreadyInConversation = conversations.some(
      (conversation) => conversation.user.id === contact.id
    );
    if (alreadyInConversation) return false;

    const term = searchTerm.toLowerCase();
    return (
      contact.name.toLowerCase().includes(term) ||
      contact.email.toLowerCase().includes(term)
    );
  });

  return (
    <div className="h-full flex gap-4">
      {/* Liste des conversations */}
      <Card className="w-80 flex flex-col">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5" />
            Messages
          </CardTitle>
          <div className="relative mt-2">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Rechercher..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-8"
            />
          </div>
        </CardHeader>
        <CardContent className="flex-1 overflow-hidden p-0">
          <ScrollArea className="h-full">
            {loading ? (
              <div className="p-4 text-center text-sm text-muted-foreground">
                Chargement...
              </div>
            ) : (
              <div className="space-y-1 p-2">
                {filteredConversations.length > 0 && (
                  <div className="space-y-1">
                    {filteredConversations.map((conv) => (
                      <button
                        key={conv.user.id}
                        onClick={() => loadConversation(conv.user.id, conv.user)}
                        className={`w-full p-3 rounded-lg text-left transition-colors ${
                          selectedConversation?.user.id === conv.user.id
                            ? "bg-primary/10"
                            : "hover:bg-muted"
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <Avatar>
                            <AvatarFallback>
                              {conv.user.name.charAt(0).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between">
                              <p className="font-medium truncate">{conv.user.name}</p>
                              {conv.unreadCount > 0 && (
                                <Badge variant="destructive" className="ml-2">
                                  {conv.unreadCount}
                                </Badge>
                              )}
                            </div>
                            <p className="text-sm text-muted-foreground truncate">
                              {conv.lastMessage?.content || "Démarrer la conversation"}
                            </p>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                <div className="pt-3 mt-2 border-t">
                  <p className="px-2 pb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Démarrer une conversation
                  </p>
                  {loadingContacts ? (
                    <div className="px-2 pb-2 text-xs text-muted-foreground">
                      Chargement des utilisateurs...
                    </div>
                  ) : filteredContacts.length === 0 ? (
                    <div className="px-2 pb-2 text-xs text-muted-foreground">
                      Aucun utilisateur disponible
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {filteredContacts.map((contact) => (
                        <button
                          key={contact.id}
                          onClick={() => loadConversation(contact.id, contact)}
                          className={`w-full p-3 rounded-lg text-left transition-colors ${
                            selectedConversation?.user.id === contact.id
                              ? "bg-primary/10"
                              : "hover:bg-muted"
                          }`}
                        >
                          <div className="flex items-start gap-3">
                            <Avatar>
                              <AvatarFallback>
                                {contact.name.charAt(0).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                            <div className="flex-1 min-w-0">
                              <p className="font-medium truncate">{contact.name}</p>
                              <p className="text-sm text-muted-foreground truncate">
                                {contact.email}
                              </p>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Zone de conversation */}
      <Card className="flex-1 flex flex-col">
        {selectedConversation ? (
          <>
            <CardHeader className="border-b">
              <div className="flex items-center gap-3">
                <Avatar>
                  <AvatarFallback>
                    {selectedConversation.user.name.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <CardTitle>{selectedConversation.user.name}</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    {selectedConversation.user.email}
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex-1 overflow-hidden p-4">
              <ScrollArea className="h-full pr-4">
                <div className="space-y-4">
                  {messages.map((message) => {
                    const isOwn = message.senderId === currentUserId;
                    return (
                      <div
                        key={message.id}
                        className={`flex ${isOwn ? "justify-end" : "justify-start"}`}
                      >
                        <div
                          className={`max-w-[70%] rounded-lg p-3 ${
                            isOwn
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted"
                          }`}
                        >
                          <p>{message.content}</p>
                          <div className="flex items-center justify-between mt-1 gap-2">
                            <p className="text-xs opacity-70">
                              {new Date(message.createdAt).toLocaleTimeString("fr-FR", {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </p>
                            {isOwn && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleDeleteMessage(message.id)}
                                className="h-6 w-6 p-0"
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </CardContent>
            <div className="p-4 border-t">
              <div className="flex gap-2">
                <Input
                  placeholder="Écrire un message..."
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  onKeyPress={(e) => e.key === "Enter" && handleSendMessage()}
                  disabled={sending}
                />
                <Button onClick={handleSendMessage} disabled={sending || !newMessage.trim()}>
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <MessageCircle className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>Sélectionnez une conversation</p>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
