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
    
    // Migration: Check if stored invite code is actually a friend code (fix for previous bug)
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
    } else {
      // Retry check after a short delay for slow mobile storage
      setTimeout(() => {
        const delayedStoredCode = localStorage.getItem('pending_invite_code');
        if (delayedStoredCode) {
          setHasInvite(true);
        }
      }, 500);
    }

    // 2. Setup Telegram widget
    window.TelegramLoginWidget = {
      dataOnauth: async (user: any) => {
        // 3. Read code dynamically at the moment of login (most reliable)
        // Priority: URL param (if not friend code) -> LocalStorage
        const currentSearchParams = new URLSearchParams(window.location.search);
        let activeInviteCode = currentSearchParams.get('invite');
        
        if (activeInviteCode && activeInviteCode.startsWith('friend-')) {
           // If URL has friend code, save it and ignore for auth
           localStorage.setItem('pending_friend_code', activeInviteCode.replace('friend-', ''));
           activeInviteCode = null;
        }
        
        if (!activeInviteCode) {
          let stored = localStorage.getItem('pending_invite_code');
          // Migration check here too just in case
          if (stored && stored.startsWith('friend-')) {
             localStorage.setItem('pending_friend_code', stored.replace('friend-', ''));
             localStorage.removeItem('pending_invite_code');
             stored = null;
          }
          activeInviteCode = stored;
        }

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
            
            // Check for pending friend code
            const pendingFriendCode = localStorage.getItem('pending_friend_code');
            if (pendingFriendCode) {
              try {
                 await fetch('/api/friends/add', {
                   method: 'POST',
                   headers: { 
                     'Content-Type': 'application/json',
                     'Authorization': `Bearer ${data.token}`
                   },
                   body: JSON.stringify({ code: pendingFriendCode })
                 });
                 localStorage.removeItem('pending_friend_code');
              } catch (e) {
                console.error('Failed to auto-add friend after login', e);
              }
            }

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

    // 3. Check for Telegram Web App (Mini App) context
    const tg = (window as any).Telegram?.WebApp;
    if (tg && tg.initData) {
      tg.ready();
      
      // Check for invite code in start_param
      const startParam = tg.initDataUnsafe?.start_param;
      let activeInviteCode = startParam;
      
      // Handle 'friend-' prefix if present in start_param
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
          
          // Check for pending friend code (from start_param or localStorage)
          const pendingFriendCode = localStorage.getItem('pending_friend_code');
          if (pendingFriendCode) {
             try {
               await fetch('/api/friends/add', {
                 method: 'POST',
                 headers: { 
                   'Content-Type': 'application/json',
                   'Authorization': `Bearer ${data.token}`
                 },
                 body: JSON.stringify({ code: pendingFriendCode })
               });
               localStorage.removeItem('pending_friend_code');
             } catch (e) {
               console.error('Failed to auto-add friend', e);
             }
          }

          navigate('/');
        } else {
          // If auto-login fails (e.g. need invite code), show error or stay on login
          if (data.error) {
             console.error('Web App Login Error:', data.error);
             // Optional: Show error to user
          }
        }
      })
      .catch(err => console.error('Web App Login Failed:', err));
    }

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
