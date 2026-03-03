import React, { useEffect, useRef } from 'react';
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

  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);
    const inviteCode = searchParams.get('invite');

    window.TelegramLoginWidget = {
      dataOnauth: async (user: any) => {
        try {
          const response = await fetch('/api/auth/telegram', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ authData: user, inviteCode })
          });
          
          const data = await response.json();
          
          if (response.ok) {
            setToken(data.token);
            setUser(data.user);
            navigate('/');
          } else {
            alert(data.error || 'Login failed');
          }
        } catch (err) {
          console.error('Login error:', err);
          alert('An error occurred during login.');
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
        <h1 className="text-2xl font-semibold text-zinc-100 mb-2">Welcome</h1>
        <p className="text-zinc-400 mb-8 text-sm">Sign in with Telegram to continue</p>
        
        <div ref={containerRef} className="flex justify-center min-h-[40px]">
          {/* Telegram widget will be injected here */}
        </div>
      </motion.div>
    </div>
  );
}
