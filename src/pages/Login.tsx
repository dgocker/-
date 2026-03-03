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

  useEffect(() => {
    // 1. Immediately save invite code from URL to localStorage if present
    const searchParams = new URLSearchParams(location.search);
    const urlInviteCode = searchParams.get('invite');
    const storedInviteCode = localStorage.getItem('pending_invite_code');
    
    if (urlInviteCode) {
      localStorage.setItem('pending_invite_code', urlInviteCode);
      setHasInvite(true);
    } else if (storedInviteCode) {
      setHasInvite(true);
    }

    // 2. Setup Telegram widget
    window.TelegramLoginWidget = {
      dataOnauth: async (user: any) => {
        // 3. Read code dynamically at the moment of login (most reliable)
        // Priority: URL param -> LocalStorage
        const currentSearchParams = new URLSearchParams(window.location.search);
        const activeInviteCode = currentSearchParams.get('invite') || localStorage.getItem('pending_invite_code');

        try {
          const response = await fetch('/api/auth/telegram', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ authData: user, inviteCode: activeInviteCode })
          });
          
          const data = await response.json();
          
          if (response.ok) {
            // Only clear code on successful login
            localStorage.removeItem('pending_invite_code');
            setToken(data.token);
            setUser(data.user);
            navigate('/');
          } else {
            alert(data.error || 'Ошибка входа');
          }
        } catch (err) {
          console.error('Login error:', err);
          alert('Произошла ошибка при входе.');
        }
      }
    };

    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    // Replace with your actual bot username in production
    script.setAttribute('data-telegram-login', import.meta.env.VITE_TELEGRAM_BOT_NAME || 'samplebot');
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-onauth', 'TelegramLoginWidget.dataOnauth(user)');
    script.setAttribute('data-request-access', 'write');
    script.async = true;
    
    if (containerRef.current) {
      containerRef.current.innerHTML = '';
      containerRef.current.appendChild(script);
    }
  }, [location, navigate, setToken, setUser]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-950">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="p-8 bg-zinc-900 rounded-2xl shadow-xl border border-zinc-800 text-center max-w-sm w-full"
      >
        <h1 className="text-2xl font-semibold text-zinc-100 mb-2">Добро пожаловать</h1>
        <p className="text-zinc-400 mb-4 text-sm">Войдите через Telegram для продолжения</p>
        
        {hasInvite && (
          <div className="mb-6 py-2 px-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-400 text-xs font-medium flex items-center justify-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"/>
            Код приглашения применен
          </div>
        )}
        
        <div ref={containerRef} className="flex justify-center min-h-[40px]">
          {/* Telegram widget will be injected here */}
        </div>
      </motion.div>
    </div>
  );
}
