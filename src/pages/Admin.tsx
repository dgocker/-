import React, { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Shield, Plus, Copy, CheckCircle2, ArrowLeft, Share2, Trash2 } from 'lucide-react';

export default function Admin() {
  const { user, token } = useStore();
  const navigate = useNavigate();
  const [invites, setInvites] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  useEffect(() => {
    if (!token || user?.role !== 'admin') {
      navigate('/');
      return;
    }

    fetchInvites();
    fetchUsers();
  }, [token, user, navigate]);

  const fetchInvites = async () => {
    try {
      const res = await fetch('/api/admin/invites', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      setInvites(data.invites);
    } catch (err) {
      console.error('Failed to fetch invites', err);
    }
  };

  const fetchUsers = async () => {
    try {
      const res = await fetch('/api/admin/users', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      setUsers(data.users);
    } catch (err) {
      console.error('Failed to fetch users', err);
    }
  };

  const deleteUser = async (userId: number) => {
    if (!confirm('Вы уверены, что хотите удалить этого пользователя? Это действие необратимо.')) return;
    
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (res.ok) {
        setUsers(users.filter(u => u.id !== userId));
      } else {
        const data = await res.json();
        alert(data.error || 'Не удалось удалить пользователя');
      }
    } catch (err) {
      console.error('Failed to delete user', err);
    }
  };

  const generateInvite = async () => {
    try {
      const res = await fetch('/api/admin/invites', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        fetchInvites();
      }
    } catch (err) {
      console.error('Failed to generate invite', err);
    }
  };

  const copyInvite = async (code: string, id: number) => {
    // Use Telegram Web App deep link format
    // Format: https://t.me/BOT_USERNAME/APP_NAME?startapp=INVITE_CODE
    const botName = import.meta.env.VITE_TELEGRAM_BOT_NAME || 'Vid_dm_qwe_bot';
    const appName = 'Call'; // Assuming 'Call' is the short name based on user request
    const link = `https://t.me/${botName}/${appName}?startapp=${code}`;
    
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Приглашение в приложение',
          text: 'Приглашаю тебя в наше закрытое приложение для видеозвонков. Используй эту ссылку для регистрации:',
          url: link
        });
      } catch (err) {
        console.error('Share failed', err);
      }
    } else {
      navigator.clipboard.writeText(link);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6 max-w-4xl mx-auto">
      <header className="flex items-center justify-between mb-12">
        <div className="flex items-center gap-4">
          <button 
            onClick={() => navigate('/')}
            className="p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Shield size={24} className="text-emerald-500" />
            Панель Админа
          </h1>
        </div>
        
        <button 
          onClick={generateInvite}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition-colors shadow-lg shadow-emerald-900/20"
        >
          <Plus size={16} />
          Создать инвайт
        </button>
      </header>

      <main>
        <div className="bg-zinc-900 rounded-2xl border border-zinc-800 overflow-hidden">
          <div className="p-6 border-b border-zinc-800">
            <h2 className="text-lg font-medium">Приглашения в приложение</h2>
            <p className="text-sm text-zinc-400 mt-1">
              Только администраторы могут создавать эти ссылки. Поделитесь ими, чтобы новые пользователи могли зарегистрироваться.
            </p>
          </div>
          
          <div className="divide-y divide-zinc-800/50">
            {invites.length === 0 ? (
              <div className="p-8 text-center text-zinc-500">
                Приглашения еще не созданы.
              </div>
            ) : (
              invites.map((invite) => (
                <motion.div 
                  key={invite.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="p-4 flex items-center justify-between hover:bg-zinc-800/30 transition-colors"
                >
                  <div>
                    <code className="px-2 py-1 bg-zinc-950 rounded text-sm text-emerald-400 font-mono border border-zinc-800">
                      {invite.code.split('-')[0]}...
                    </code>
                    <div className="mt-2 text-xs text-zinc-500 flex items-center gap-4">
                      <span>Создано: {new Date(invite.created_at).toLocaleDateString()}</span>
                      {invite.used_by ? (
                        <span className="text-zinc-300">Использовал @{invite.used_by_username}</span>
                      ) : (
                        <span className="text-emerald-500/70">Не использовано</span>
                      )}
                    </div>
                  </div>
                  
                  <button 
                    onClick={() => copyInvite(invite.code, invite.id)}
                    disabled={!!invite.used_by}
                    className={`p-2 rounded-lg transition-colors ${
                      invite.used_by 
                        ? 'text-zinc-600 cursor-not-allowed' 
                        : copiedId === invite.id
                          ? 'bg-emerald-500/20 text-emerald-400'
                          : 'bg-zinc-800 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700'
                    }`}
                  >
                    {copiedId === invite.id ? <CheckCircle2 size={18} /> : <Share2 size={18} />}
                  </button>
                </motion.div>
              ))
            )}
          </div>
        </div>

        <div className="bg-zinc-900 rounded-2xl border border-zinc-800 overflow-hidden mt-8">
          <div className="p-6 border-b border-zinc-800">
            <h2 className="text-lg font-medium">Пользователи</h2>
            <p className="text-sm text-zinc-400 mt-1">
              Управление зарегистрированными пользователями.
            </p>
          </div>
          
          <div className="divide-y divide-zinc-800/50">
            {users.length === 0 ? (
              <div className="p-8 text-center text-zinc-500">
                Пользователей нет.
              </div>
            ) : (
              users.map((u) => (
                <motion.div 
                  key={u.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="p-4 flex items-center justify-between hover:bg-zinc-800/30 transition-colors"
                >
                  <div className="flex items-center gap-4">
                    {u.photo_url ? (
                      <img src={u.photo_url} alt={u.first_name} className="w-10 h-10 rounded-full" />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center">
                        <span className="text-lg font-medium">{u.first_name?.[0]}</span>
                      </div>
                    )}
                    <div>
                      <p className="font-medium flex items-center gap-2">
                        {u.first_name} {u.last_name}
                        {u.role === 'admin' && <span className="text-xs bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded border border-emerald-500/20">Admin</span>}
                      </p>
                      <p className="text-xs text-zinc-400">@{u.username} • ID: {u.id}</p>
                    </div>
                  </div>
                  
                  {u.id !== user?.id && (
                    <button 
                      onClick={() => deleteUser(u.id)}
                      className="p-2 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                      title="Удалить пользователя"
                    >
                      <Trash2 size={18} />
                    </button>
                  )}
                </motion.div>
              ))
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
