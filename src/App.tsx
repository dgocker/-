import { useState } from 'react';
import { Lobby } from './components/Lobby';
import { VideoRoom } from './components/VideoRoom';

export default function App() {
  const [roomId, setRoomId] = useState<string | null>(null);

  return (
    <div className="w-full h-full font-sans">
      {roomId ? (
        <VideoRoom roomId={roomId} onLeave={() => setRoomId(null)} />
      ) : (
        <Lobby onJoin={setRoomId} />
      )}
    </div>
  );
}
