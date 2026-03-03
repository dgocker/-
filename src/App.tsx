import { useState, useEffect } from 'react';
import { Lobby } from './components/Lobby';
import { VideoRoom } from './components/VideoRoom';

export default function App() {
  const [roomId, setRoomId] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get('room');
    if (roomFromUrl) {
      setRoomId(roomFromUrl);
    }
  }, []);

  const handleJoin = (id: string) => {
    setRoomId(id);
    window.history.pushState({}, '', `?room=${id}`);
  };

  const handleLeave = () => {
    setRoomId(null);
    window.history.pushState({}, '', window.location.pathname);
  };

  return (
    <div className="w-full h-full font-sans">
      {roomId ? (
        <VideoRoom roomId={roomId} onLeave={handleLeave} />
      ) : (
        <Lobby onJoin={handleJoin} />
      )}
    </div>
  );
}
