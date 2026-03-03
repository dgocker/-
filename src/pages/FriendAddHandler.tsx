import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useStore } from '../store/useStore';
import { motion } from 'framer-motion';
import { io } from 'socket.io-client';

export default function FriendAddHandler() {
  const { code } = useParams();
  const navigate = useNavigate();
  const { token } = useStore();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('Добавление друга...');

  useEffect(() => {
    if (!token) {
      navigate(`/login?redirect=/add-friend/${code}`);
      return;
    }

    const addFriend = async () => {
      try {
        const res = await fetch('/api/friends/add', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ code })
        });

        const data = await res.json();

        if (res.ok) {
          setStatus('success');
          setMessage('Друг успешно добавлен!');
          
          // Notify socket to refresh friends list
          const socket = io({
             auth: { token }
          });
          socket.emit('refresh_friends');
          
          setTimeout(() => navigate('/'), 2000);
        } else {
          setStatus('error');
          setMessage(data.error || 'Не удалось добавить друга');
        }
      } catch (err) {
        setStatus('error');
        setMessage('Произошла ошибка');
      }
    };

    addFriend();
  }, [code, navigate, token]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-950">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="p-8 bg-zinc-900 rounded-2xl shadow-xl border border-zinc-800 text-center max-w-sm w-full"
      >
        <h2 className={`text-xl font-semibold mb-4 ${
          status === 'success' ? 'text-emerald-400' : 
          status === 'error' ? 'text-red-400' : 'text-zinc-100'
        }`}>
          {status === 'loading' ? 'Обработка...' : 
           status === 'success' ? 'Успешно!' : 'Ой!'}
        </h2>
        <p className="text-zinc-400">{message}</p>
        
        {status !== 'loading' && (
          <button 
            onClick={() => navigate('/')}
            className="mt-6 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 rounded-lg transition-colors"
          >
            На главную
          </button>
        )}
      </motion.div>
    </div>
  );
}
