import React, { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useStore } from '../store/useStore';

export default function InviteHandler() {
  const { code } = useParams();
  const navigate = useNavigate();
  const { token } = useStore();

  useEffect(() => {
    if (token) {
      navigate('/');
    } else {
      if (code) {
        // Save to local storage
        localStorage.setItem('pending_invite_code', code);
        
        // Small delay to ensure localStorage is written on mobile devices
        setTimeout(() => {
          // Use href instead of replace to ensure full navigation event
          window.location.href = `/login?invite=${code}`;
        }, 100);
      } else {
        navigate('/login');
      }
    }
  }, [code, navigate, token]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-950 text-zinc-400">
      Обработка приглашения...
    </div>
  );
}
