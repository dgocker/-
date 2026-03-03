import React, { useEffect, useState, useRef } from 'react';
import { useStore } from '../store/useStore';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { io, Socket } from 'socket.io-client';
import { Phone, PhoneOff, Video, Users, LogOut, Copy, CheckCircle2 } from 'lucide-react';
import { useWebRTC } from '../hooks/useWebRTC';

let socket: Socket;

export default function Dashboard() {
  const { user, token, logout, onlineFriends, setOnlineFriends, addOnlineFriend, removeOnlineFriend } = useStore();
  const navigate = useNavigate();
  const [friends, setFriends] = useState<any[]>([]);
  const [linkCopied, setLinkCopied] = useState(false);
  
  // Call state
  const [incomingCall, setIncomingCall] = useState<any>(null);
  const [callActive, setCallActive] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [activeCallUserId, setActiveCallUserId] = useState<number | null>(null);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  const handleCallEnded = () => {
    setCallActive(false);
    setIncomingCall(null);
    setActiveCallUserId(null);
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    setLocalStream(null);
    setRemoteStream(null);
  };

  const { initiateCall, cleanup } = useWebRTC(socket, localStream, setRemoteStream, handleCallEnded);

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  useEffect(() => {
    if (!token) {
      navigate('/login');
      return;
    }

    // Fetch friends
    fetch('/api/friends', {
      headers: { Authorization: `Bearer ${token}` }
    })
    .then(res => res.json())
    .then(data => setFriends(data.friends));

    // Socket setup
    socket = io({
      auth: { token }
    });

    socket.on('online_friends', (friends: number[]) => {
      setOnlineFriends(friends);
    });

    socket.on('friend_online', ({ userId }) => {
      addOnlineFriend(userId);
    });

    socket.on('friend_offline', ({ userId }) => {
      removeOnlineFriend(userId);
    });

    socket.on('call_incoming', (data) => {
      setIncomingCall(data);
    });

    socket.on('call_accepted', ({ from }) => {
      setCallActive(true);
      setActiveCallUserId(from);
      initiateCall(from);
    });

    socket.on('call_ended', () => {
      handleCallEnded();
      cleanup();
    });

    return () => {
      socket.disconnect();
      cleanup();
    };
  }, [token, navigate, setOnlineFriends, addOnlineFriend, removeOnlineFriend]);

  const generateFriendLink = async () => {
    try {
      const res = await fetch('/api/friends/links', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        const link = `${window.location.origin}/add-friend/${data.link.code}`;
        navigator.clipboard.writeText(link);
        setLinkCopied(true);
        setTimeout(() => setLinkCopied(false), 2000);
      }
    } catch (err) {
      console.error('Failed to generate link', err);
    }
  };

  const startCall = async (friendId: number) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      setCallActive(true);
      setActiveCallUserId(friendId);
      
      socket.emit('call_user', {
        userToCall: friendId,
        from: user?.id,
        name: user?.first_name
      });
    } catch (err) {
      console.error('Failed to get media devices', err);
      alert('Could not access camera/microphone');
    }
  };

  const answerCall = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      setCallActive(true);
      setActiveCallUserId(incomingCall.from);
      
      socket.emit('answer_call', {
        to: incomingCall.from
      });
      setIncomingCall(null);
    } catch (err) {
      console.error('Failed to get media devices', err);
    }
  };

  const endCall = () => {
    if (activeCallUserId) {
      socket.emit('end_call', { to: activeCallUserId });
    } else if (incomingCall) {
      socket.emit('end_call', { to: incomingCall.from });
    }
    handleCallEnded();
    cleanup();
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6 max-w-4xl mx-auto">
      <header className="flex items-center justify-between mb-12">
        <div className="flex items-center gap-4">
          {user?.photo_url ? (
            <img src={user.photo_url} alt="Profile" className="w-12 h-12 rounded-full border border-zinc-800" />
          ) : (
            <div className="w-12 h-12 rounded-full bg-zinc-800 flex items-center justify-center">
              <span className="text-xl font-medium">{user?.first_name?.[0]}</span>
            </div>
          )}
          <div>
            <h1 className="text-xl font-semibold">{user?.first_name} {user?.last_name}</h1>
            <p className="text-sm text-zinc-400">@{user?.username}</p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          {user?.role === 'admin' && (
            <button 
              onClick={() => navigate('/admin')}
              className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm font-medium transition-colors"
            >
              Admin Panel
            </button>
          )}
          <button 
            onClick={logout}
            className="p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <LogOut size={20} />
          </button>
        </div>
      </header>

      <main>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-semibold flex items-center gap-2">
            <Users size={24} className="text-zinc-400" />
            Friends
          </h2>
          <button 
            onClick={generateFriendLink}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {linkCopied ? <CheckCircle2 size={16} /> : <Copy size={16} />}
            {linkCopied ? 'Copied!' : 'Invite Friend'}
          </button>
        </div>

        <div className="grid gap-4">
          {friends.length === 0 ? (
            <div className="text-center py-12 bg-zinc-900/50 rounded-2xl border border-zinc-800/50">
              <p className="text-zinc-400">You haven't added any friends yet.</p>
              <p className="text-sm text-zinc-500 mt-2">Generate an invite link and share it!</p>
            </div>
          ) : (
            friends.map(friend => {
              const isOnline = onlineFriends.includes(friend.id);
              return (
                <motion.div 
                  key={friend.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center justify-between p-4 bg-zinc-900 rounded-xl border border-zinc-800"
                >
                  <div className="flex items-center gap-4">
                    <div className="relative">
                      {friend.photo_url ? (
                        <img src={friend.photo_url} alt={friend.first_name} className="w-10 h-10 rounded-full" />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center">
                          <span className="text-lg font-medium">{friend.first_name?.[0]}</span>
                        </div>
                      )}
                      <div className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-zinc-900 ${isOnline ? 'bg-emerald-500' : 'bg-zinc-500'}`} />
                    </div>
                    <div>
                      <p className="font-medium">{friend.first_name} {friend.last_name}</p>
                      <p className="text-xs text-zinc-400">@{friend.username}</p>
                    </div>
                  </div>
                  
                  <button 
                    onClick={() => startCall(friend.id)}
                    disabled={!isOnline || callActive}
                    className={`p-3 rounded-full transition-colors ${
                      isOnline && !callActive 
                        ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20' 
                        : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                    }`}
                  >
                    <Video size={20} />
                  </button>
                </motion.div>
              );
            })
          )}
        </div>
      </main>

      {/* Incoming Call Modal */}
      {incomingCall && !callActive && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 backdrop-blur-sm">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-zinc-900 p-8 rounded-3xl border border-zinc-800 text-center max-w-sm w-full"
          >
            <div className="w-20 h-20 bg-zinc-800 rounded-full mx-auto mb-4 flex items-center justify-center animate-pulse">
              <Phone size={32} className="text-emerald-400" />
            </div>
            <h3 className="text-xl font-semibold mb-2">{incomingCall.name} is calling</h3>
            <p className="text-zinc-400 mb-8">Incoming video call...</p>
            
            <div className="flex justify-center gap-6">
              <button 
                onClick={endCall}
                className="w-14 h-14 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center text-white transition-colors"
              >
                <PhoneOff size={24} />
              </button>
              <button 
                onClick={answerCall}
                className="w-14 h-14 bg-emerald-500 hover:bg-emerald-600 rounded-full flex items-center justify-center text-white transition-colors"
              >
                <Phone size={24} />
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Active Call Overlay */}
      {callActive && (
        <div className="fixed inset-0 bg-black z-50 flex flex-col">
          <div className="flex-1 relative">
            {/* Remote Video */}
            <div className="absolute inset-0 bg-zinc-900 flex items-center justify-center">
              <video 
                ref={remoteVideoRef} 
                autoPlay 
                playsInline 
                className="w-full h-full object-cover"
              />
              {!remoteStream && (
                <p className="text-zinc-500 absolute">Connecting...</p>
              )}
            </div>
            
            {/* Local Video */}
            <div className="absolute bottom-8 right-8 w-48 h-64 bg-zinc-800 rounded-2xl overflow-hidden shadow-2xl border border-zinc-700 flex items-center justify-center">
               <video 
                ref={localVideoRef} 
                autoPlay 
                playsInline 
                muted 
                className="w-full h-full object-cover"
              />
            </div>
          </div>
          
          <div className="h-24 bg-zinc-950 border-t border-zinc-900 flex items-center justify-center gap-6">
            <button 
              onClick={endCall}
              className="w-14 h-14 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center text-white transition-colors shadow-lg shadow-red-500/20"
            >
              <PhoneOff size={24} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
