import { apiClient } from "./api";
import { User } from "../App";

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest extends LoginRequest {
  name: string;
  role: string;
  specialization?: string;
}

export const authService = {
  login: async (credentials: LoginRequest) => {
    return await apiClient.post<{ user: User; token: string }>(
      "/auth/login",
      credentials,
      true // Skip auth for login
    );
  },

  register: async (userData: RegisterRequest) => {
    console.log('🔧 Register data:', userData);
    return await apiClient.post<{ user: User; token: string }>(
      "/auth/register",
      userData,
      true // Skip auth for registration
    );
  },

  logout: async () => {
    localStorage.removeItem("token");
    return { success: true };
  },

  getCurrentUser: async () => {
    return await apiClient.get<User>("/auth/me");
  },
};
