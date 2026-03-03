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
      navigate(`/login?invite=${code}`);
    }
  }, [code, navigate, token]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-950 text-zinc-400">
      Processing invite...
    </div>
  );
}
