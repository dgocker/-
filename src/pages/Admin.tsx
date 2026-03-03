import React, { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Shield, Plus, Copy, CheckCircle2, ArrowLeft } from 'lucide-react';

export default function Admin() {
  const { user, token } = useStore();
  const navigate = useNavigate();
  const [invites, setInvites] = useState<any[]>([]);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  useEffect(() => {
    if (!token || user?.role !== 'admin') {
      navigate('/');
      return;
    }

    fetchInvites();
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

  const copyInvite = (code: string, id: number) => {
    const link = `${window.location.origin}/invite/${code}`;
    navigator.clipboard.writeText(link);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
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
            Admin Panel
          </h1>
        </div>
        
        <button 
          onClick={generateInvite}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition-colors shadow-lg shadow-emerald-900/20"
        >
          <Plus size={16} />
          Generate App Invite
        </button>
      </header>

      <main>
        <div className="bg-zinc-900 rounded-2xl border border-zinc-800 overflow-hidden">
          <div className="p-6 border-b border-zinc-800">
            <h2 className="text-lg font-medium">App Invites</h2>
            <p className="text-sm text-zinc-400 mt-1">
              Only admins can generate these links. Share them to allow new users to join the app.
            </p>
          </div>
          
          <div className="divide-y divide-zinc-800/50">
            {invites.length === 0 ? (
              <div className="p-8 text-center text-zinc-500">
                No invites generated yet.
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
                      <span>Created: {new Date(invite.created_at).toLocaleDateString()}</span>
                      {invite.used_by ? (
                        <span className="text-zinc-300">Used by @{invite.used_by_username}</span>
                      ) : (
                        <span className="text-emerald-500/70">Unused</span>
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
                    {copiedId === invite.id ? <CheckCircle2 size={18} /> : <Copy size={18} />}
                  </button>
                </motion.div>
              ))
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
