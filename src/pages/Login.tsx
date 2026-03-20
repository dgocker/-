import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';

declare global {
  interface Window {
    TelegramLoginWidget: {
      dataOnauth: (user: any) => void;
    };
  }
}

export default function Login() {
  const { setToken, setUser } = useStore();
  const navigate = useNavigate();
  const location = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);

  const [hasInvite, setHasInvite] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  
  // New state for Login/Password
  const [isRegistering, setIsRegistering] = useState(false);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    
    const endpoint = isRegistering ? '/api/auth/register' : '/api/auth/login';
    const body = isRegistering 
      ? { login, password, first_name: firstName, inviteCode: localStorage.getItem('pending_invite_code') }
      : { login, password };

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      
      const data = await response.json();
      
      if (response.ok) {
        localStorage.removeItem('pending_invite_code');
        setToken(data.token);
        setUser(data.user);
        navigate('/');
      } else {
        showToast(data.error || 'Ошибка входа');
      }
    } catch (err) {
      console.error('Auth error:', err);
      showToast('Произошла ошибка.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    // 1. Immediately save invite code from URL to localStorage if present
    const searchParams = new URLSearchParams(location.search);
    const urlInviteCode = searchParams.get('invite');
    
    // Migration: Check if stored invite code is actually a friend code
    const existingStoredCode = localStorage.getItem('pending_invite_code');
    if (existingStoredCode && existingStoredCode.startsWith('friend-')) {
       localStorage.setItem('pending_friend_code', existingStoredCode.replace('friend-', ''));
       localStorage.removeItem('pending_invite_code');
    }
    
    if (urlInviteCode) {
      if (urlInviteCode.startsWith('friend-')) {
        localStorage.setItem('pending_friend_code', urlInviteCode.replace('friend-', ''));
      } else {
        localStorage.setItem('pending_invite_code', urlInviteCode);
        setHasInvite(true);
      }
    }
    
    // Check for stored app invite code
    const storedInviteCode = localStorage.getItem('pending_invite_code');
    if (storedInviteCode) {
      setHasInvite(true);
    }

    // 2. Setup Telegram widget
    window.TelegramLoginWidget = {
      dataOnauth: async (user: any) => {
        const currentSearchParams = new URLSearchParams(window.location.search);
        let activeInviteCode = currentSearchParams.get('invite');
        
        if (activeInviteCode && activeInviteCode.startsWith('friend-')) {
           localStorage.setItem('pending_friend_code', activeInviteCode.replace('friend-', ''));
           activeInviteCode = null;
        }
        
        if (!activeInviteCode) {
          activeInviteCode = localStorage.getItem('pending_invite_code');
        }

        try {
          const response = await fetch('/api/auth/telegram', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ authData: user, inviteCode: activeInviteCode })
          });
          
          const data = await response.json();
          
          if (response.ok) {
            localStorage.removeItem('pending_invite_code');
            setToken(data.token);
            setUser(data.user);
            navigate('/');
          } else {
            showToast(data.error || 'Ошибка входа');
          }
        } catch (err) {
          console.error('Login error:', err);
          showToast('Произошла ошибка при входе.');
        }
      }
    };

    // 3. Check for Telegram Web App (Mini App) context
    const tg = (window as any).Telegram?.WebApp;
    if (tg && tg.initData) {
      tg.ready();
      const startParam = tg.initDataUnsafe?.start_param;
      let activeInviteCode = startParam;
      
      if (activeInviteCode && activeInviteCode.startsWith('friend-')) {
          localStorage.setItem('pending_friend_code', activeInviteCode.replace('friend-', ''));
          activeInviteCode = null;
      }
      
      if (!activeInviteCode) {
        activeInviteCode = localStorage.getItem('pending_invite_code');
      }
      
      if (activeInviteCode) {
        setHasInvite(true);
      }

      // Auto-login
      fetch('/api/auth/telegram-webapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: tg.initData, inviteCode: activeInviteCode })
      })
      .then(res => res.json())
      .then(async (data) => {
        if (data.token) {
          localStorage.removeItem('pending_invite_code');
          setToken(data.token);
          setUser(data.user);
          navigate('/');
        }
      })
      .catch(err => console.error('Web App Login Failed:', err));
    }

    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.setAttribute('data-telegram-login', import.meta.env.VITE_TELEGRAM_BOT_NAME || 'samplebot');
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-onauth', 'TelegramLoginWidget.dataOnauth(user)');
    script.setAttribute('data-request-access', 'write');
    script.async = true;
    
    if (containerRef.current) {
      containerRef.current.innerHTML = '';
      containerRef.current.appendChild(script);
    }

    return () => {
      delete (window as any).TelegramLoginWidget;
    };
  }, [location, navigate, setToken, setUser]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-950 p-4">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] bg-zinc-800 text-white px-4 py-2 rounded-full shadow-lg border border-zinc-700 text-sm animate-in fade-in slide-in-from-top-4">
          {toastMessage}
        </div>
      )}

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="p-8 bg-zinc-900 rounded-3xl shadow-2xl border border-zinc-800 text-center max-w-sm w-full"
      >
        <h1 className="text-3xl font-bold text-zinc-100 mb-2">
          {isRegistering ? 'Создать аккаунт' : 'С возвращением'}
        </h1>
        <p className="text-zinc-400 mb-8 text-sm">
          {isRegistering ? 'Зарегистрируйтесь для начала общения' : 'Войдите в свой аккаунт'}
        </p>
        
        <form onSubmit={handleAuth} className="space-y-4 mb-8 text-left">
          {isRegistering && (
            <div>
              <label className="block text-xs font-medium text-zinc-500 mb-1 ml-1">ИМЯ</label>
              <input 
                type="text" 
                value={firstName} 
                onChange={(e) => setFirstName(e.target.value)}
                required
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all placeholder:text-zinc-700"
                placeholder="Ваше имя"
              />
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-zinc-500 mb-1 ml-1">ЛОГИН</label>
            <input 
              type="text" 
              value={login} 
              onChange={(e) => setLogin(e.target.value)}
              required
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all placeholder:text-zinc-700"
              placeholder="Введите логин"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-500 mb-1 ml-1">ПАРОЛЬ</label>
            <input 
              type="password" 
              value={password} 
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all placeholder:text-zinc-700"
              placeholder="••••••••"
            />
          </div>

          <button 
            type="submit" 
            disabled={isLoading}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 text-white font-semibold py-3 rounded-xl transition-all shadow-lg shadow-blue-900/20 active:scale-[0.98]"
          >
            {isLoading ? 'Загрузка...' : (isRegistering ? 'Зарегистрироваться' : 'Войти')}
          </button>
        </form>

        <div className="relative mb-8">
          <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-zinc-800"></div></div>
          <div className="relative flex justify-center text-xs uppercase"><span className="bg-zinc-900 px-2 text-zinc-600 tracking-widest">ИЛИ</span></div>
        </div>

        <div ref={containerRef} className="flex justify-center min-h-[40px] mb-8">
          {/* Telegram widget */}
        </div>
        
        <button 
          onClick={() => setIsRegistering(!isRegistering)}
          className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
        >
          {isRegistering ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться'}
        </button>
      </motion.div>
    </div>
  );
}
