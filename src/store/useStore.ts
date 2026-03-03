import { create } from 'zustand';

interface User {
  id: number;
  telegram_id: string;
  first_name: string;
  last_name: string;
  username: string;
  photo_url: string;
  role: string;
}

interface StoreState {
  user: User | null;
  token: string | null;
  onlineFriends: number[];
  setUser: (user: User | null) => void;
  setToken: (token: string | null) => void;
  setOnlineFriends: (friends: number[]) => void;
  addOnlineFriend: (id: number) => void;
  removeOnlineFriend: (id: number) => void;
  logout: () => void;
}

export const useStore = create<StoreState>((set) => ({
  user: null,
  token: localStorage.getItem('token'),
  onlineFriends: [],
  setUser: (user) => set({ user }),
  setToken: (token) => {
    if (token) {
      localStorage.setItem('token', token);
    } else {
      localStorage.removeItem('token');
    }
    set({ token });
  },
  setOnlineFriends: (friends) => set({ onlineFriends: friends }),
  addOnlineFriend: (id) => set((state) => ({ 
    onlineFriends: state.onlineFriends.includes(id) ? state.onlineFriends : [...state.onlineFriends, id] 
  })),
  removeOnlineFriend: (id) => set((state) => ({ 
    onlineFriends: state.onlineFriends.filter(fId => fId !== id) 
  })),
  logout: () => {
    localStorage.removeItem('token');
    set({ user: null, token: null, onlineFriends: [] });
  }
}));
