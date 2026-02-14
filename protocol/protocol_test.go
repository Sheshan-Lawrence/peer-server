// protocol/protocol_test.go
package protocol

import (
	"testing"
)

func TestEncodeDecodeMessage(t *testing.T) {
	msg := NewMessage(TypePing, "abc123", nil)
	data, err := Encode(msg)
	if err != nil {
		t.Fatalf("encode error: %v", err)
	}
	decoded, err := Decode(data)
	if err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if decoded.Type != TypePing {
		t.Errorf("expected type %s, got %s", TypePing, decoded.Type)
	}
	if decoded.From != "abc123" {
		t.Errorf("expected from abc123, got %s", decoded.From)
	}
}

func TestEncodeDecodeWithPayload(t *testing.T) {
	payload := RegisteredPayload{Fingerprint: "fp123", Alias: "cool-fox-01"}
	msg := NewMessage(TypeRegistered, "server", payload)
	data, err := Encode(msg)
	if err != nil {
		t.Fatalf("encode error: %v", err)
	}
	decoded, err := Decode(data)
	if err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if decoded.Type != TypeRegistered {
		t.Errorf("expected type %s, got %s", TypeRegistered, decoded.Type)
	}

	var rp RegisteredPayload
	if err := json.Unmarshal(decoded.Payload, &rp); err != nil {
		t.Fatalf("unmarshal payload error: %v", err)
	}
	if rp.Fingerprint != "fp123" {
		t.Errorf("expected fingerprint fp123, got %s", rp.Fingerprint)
	}
	if rp.Alias != "cool-fox-01" {
		t.Errorf("expected alias cool-fox-01, got %s", rp.Alias)
	}
}

func TestDecodeInvalidJSON(t *testing.T) {
	_, err := Decode([]byte("not json"))
	if err == nil {
		t.Error("expected error for invalid json")
	}
}

func TestNewError(t *testing.T) {
	msg := NewError(400, "bad request")
	if msg.Type != TypeError {
		t.Errorf("expected type %s, got %s", TypeError, msg.Type)
	}
	var ep ErrorPayload
	if err := json.Unmarshal(msg.Payload, &ep); err != nil {
		t.Fatalf("unmarshal error payload: %v", err)
	}
	if ep.Code != 400 {
		t.Errorf("expected code 400, got %d", ep.Code)
	}
	if ep.Message != "bad request" {
		t.Errorf("expected message 'bad request', got %s", ep.Message)
	}
}

func TestNewMessageNilPayload(t *testing.T) {
	msg := NewMessage(TypePong, "", nil)
	if msg.Type != TypePong {
		t.Errorf("expected type %s, got %s", TypePong, msg.Type)
	}
	data, err := Encode(msg)
	if err != nil {
		t.Fatalf("encode error: %v", err)
	}
	decoded, err := Decode(data)
	if err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if decoded.Type != TypePong {
		t.Errorf("expected type %s, got %s", TypePong, decoded.Type)
	}
}

func TestPreEncodedPongBytes(t *testing.T) {
	if len(PongBytes) == 0 {
		t.Error("PongBytes should not be empty")
	}
	decoded, err := Decode(PongBytes)
	if err != nil {
		t.Fatalf("decode PongBytes error: %v", err)
	}
	if decoded.Type != TypePong {
		t.Errorf("expected type %s, got %s", TypePong, decoded.Type)
	}
}

func TestPreEncodedRateLimitBytes(t *testing.T) {
	if len(RateLimitBytes) == 0 {
		t.Error("RateLimitBytes should not be empty")
	}
	decoded, err := Decode(RateLimitBytes)
	if err != nil {
		t.Fatalf("decode RateLimitBytes error: %v", err)
	}
	if decoded.Type != TypeError {
		t.Errorf("expected type %s, got %s", TypeError, decoded.Type)
	}
	var ep ErrorPayload
	if err := json.Unmarshal(decoded.Payload, &ep); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if ep.Code != 429 {
		t.Errorf("expected code 429, got %d", ep.Code)
	}
}

func TestMessagePoolAcquireRelease(t *testing.T) {
	msg := AcquireMessage()
	if msg == nil {
		t.Fatal("AcquireMessage returned nil")
	}
	msg.Type = TypePing
	msg.From = "test"
	ReleaseMessage(msg)

	msg2 := AcquireMessage()
	if msg2.Type != "" {
		t.Errorf("expected empty type after release, got %s", msg2.Type)
	}
	if msg2.From != "" {
		t.Errorf("expected empty from after release, got %s", msg2.From)
	}
	ReleaseMessage(msg2)
}

func TestReleaseNilMessage(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("ReleaseMessage(nil) panicked: %v", r)
		}
	}()
	ReleaseMessage(nil)
}

func TestBufferPoolAcquireRelease(t *testing.T) {
	buf := AcquireBuffer()
	if buf == nil {
		t.Fatal("AcquireBuffer returned nil")
	}
	*buf = append(*buf, []byte("test data")...)
	if len(*buf) != 9 {
		t.Errorf("expected len 9, got %d", len(*buf))
	}
	ReleaseBuffer(buf)
}

func TestReleaseNilBuffer(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("ReleaseBuffer(nil) panicked: %v", r)
		}
	}()
	ReleaseBuffer(nil)
}

func TestEncodeAllPayloadTypes(t *testing.T) {
	tests := []struct {
		name    string
		msgType string
		payload interface{}
	}{
		{"join", TypeJoin, JoinPayload{Namespace: "test", AppType: "app"}},
		{"register", TypeRegister, RegisterPayload{PublicKey: "key123"}},
		{"discover", TypeDiscover, DiscoverPayload{Namespace: "test", Limit: 10}},
		{"match", TypeMatch, MatchPayload{Namespace: "test", GroupSize: 2}},
		{"matched", TypeMatched, MatchedPayload{Namespace: "test", SessionID: "s1", Peers: []PeerInfo{}}},
		{"peer_list", TypePeerList, PeerListPayload{Namespace: "test", Peers: []PeerInfo{}, Total: 0}},
		{"broadcast", TypeBroadcast, BroadcastPayload{Namespace: "test"}},
		{"metadata", TypeMetadata, MetadataPayload{Meta: map[string]interface{}{"key": "val"}}},
		{"create_room", TypeCreateRoom, CreateRoomPayload{RoomID: "room1", MaxSize: 10}},
		{"room_created", TypeRoomCreated, RoomCreatedPayload{RoomID: "room1", MaxSize: 10, Owner: "fp1"}},
		{"join_room", TypeJoinRoom, JoinRoomPayload{RoomID: "room1"}},
		{"room_info", TypeRoomInfo, RoomInfoPayload{RoomID: "room1", PeerCount: 5, MaxSize: 10, Owner: "fp1"}},
		{"room_closed", TypeRoomClosed, RoomClosedPayload{RoomID: "room1", Reason: "owner left"}},
		{"kick", TypeKick, KickPayload{RoomID: "room1", Fingerprint: "fp2"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			msg := NewMessage(tt.msgType, "sender", tt.payload)
			data, err := Encode(msg)
			if err != nil {
				t.Fatalf("encode error: %v", err)
			}
			decoded, err := Decode(data)
			if err != nil {
				t.Fatalf("decode error: %v", err)
			}
			if decoded.Type != tt.msgType {
				t.Errorf("expected type %s, got %s", tt.msgType, decoded.Type)
			}
		})
	}
}

func BenchmarkEncode(b *testing.B) {
	msg := NewMessage(TypeSignal, "sender123", SignalPayload{
		SignalType: SignalOffer,
		SDP:        "v=0\r\no=- 123 456 IN IP4 127.0.0.1\r\n",
	})
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		Encode(msg)
	}
}

func BenchmarkDecode(b *testing.B) {
	msg := NewMessage(TypeSignal, "sender123", SignalPayload{
		SignalType: SignalOffer,
		SDP:        "v=0\r\no=- 123 456 IN IP4 127.0.0.1\r\n",
	})
	data, _ := Encode(msg)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		decoded, _ := Decode(data)
		ReleaseMessage(decoded)
	}
}
