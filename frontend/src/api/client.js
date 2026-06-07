import axios from 'axios';
import { useAuth } from '../store/auth.js';

export const api = axios.create({
  baseURL: (import.meta.env.VITE_API_BASE || '') + '/api',
  withCredentials: false,
});

api.interceptors.request.use((config) => {
  const token = useAuth.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      useAuth.getState().logout();
    }
    return Promise.reject(err);
  },
);

export const apiBase = (import.meta.env.VITE_API_BASE || '') + '/api';
