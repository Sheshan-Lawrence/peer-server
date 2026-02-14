package protocol

import (
	"sync"

	jsoniter "github.com/json-iterator/go"
)

var json = jsoniter.ConfigCompatibleWithStandardLibrary

var messagePool = sync.Pool{
	New: func() interface{} {
		return &Message{}
	},
}

func AcquireMessage() *Message {
	msg := messagePool.Get().(*Message)
	msg.Type = ""
	msg.From = ""
	msg.To = ""
	msg.Namespace = ""
	msg.Payload = nil
	msg.Timestamp = 0
	msg.NodeID = ""
	return msg
}

func ReleaseMessage(msg *Message) {
	if msg == nil {
		return
	}
	msg.Type = ""
	msg.From = ""
	msg.To = ""
	msg.Namespace = ""
	msg.Payload = nil
	msg.Timestamp = 0
	msg.NodeID = ""
	messagePool.Put(msg)
}

var bufPool = sync.Pool{
	New: func() interface{} {
		b := make([]byte, 0, 512)
		return &b
	},
}

func AcquireBuffer() *[]byte {
	return bufPool.Get().(*[]byte)
}

func ReleaseBuffer(b *[]byte) {
	if b == nil {
		return
	}
	*b = (*b)[:0]
	bufPool.Put(b)
}

const (
	TypeRegister    = "register"
	TypeRegistered  = "registered"
	TypeJoin        = "join"
	TypeLeave       = "leave"
	TypeSignal      = "signal"
	TypeDiscover    = "discover"
	TypePeerList    = "peer_list"
	TypeMatch       = "match"
	TypeMatched     = "matched"
	TypeRelay       = "relay"
	TypePing        = "ping"
	TypePong        = "pong"
	TypeError       = "error"
	TypePeerJoined  = "peer_joined"
	TypePeerLeft    = "peer_left"
	TypeKick        = "kick"
	TypeBroadcast   = "broadcast"
	TypeMetadata    = "metadata"
	TypeCreateRoom  = "create_room"
	TypeRoomCreated = "room_created"
	TypeJoinRoom    = "join_room"
	TypeRoomInfo    = "room_info"
	TypeRoomClosed  = "room_closed"
)

const (
	SignalOffer     = "offer"
	SignalAnswer    = "answer"
	SignalCandidate = "candidate"
)

type Message struct {
	Type      string              `json:"type"`
	From      string              `json:"from,omitempty"`
	To        string              `json:"to,omitempty"`
	Namespace string              `json:"namespace,omitempty"`
	Payload   jsoniter.RawMessage `json:"payload,omitempty"`
	Timestamp int64               `json:"ts,omitempty"`
	NodeID    string              `json:"node_id,omitempty"`
}

type RegisterPayload struct {
	PublicKey string                 `json:"public_key"`
	Alias     string                 `json:"alias,omitempty"`
	Meta      map[string]interface{} `json:"meta,omitempty"`
}

type RegisteredPayload struct {
	Fingerprint string `json:"fingerprint"`
	Alias       string `json:"alias"`
}

type JoinPayload struct {
	Namespace string                 `json:"namespace"`
	AppType   string                 `json:"app_type"`
	Version   string                 `json:"version,omitempty"`
	Meta      map[string]interface{} `json:"meta,omitempty"`
}

type SignalPayload struct {
	SignalType string              `json:"signal_type"`
	SDP        string              `json:"sdp,omitempty"`
	Candidate  jsoniter.RawMessage `json:"candidate,omitempty"`
}

type DiscoverPayload struct {
	Namespace string `json:"namespace"`
	Limit     int    `json:"limit,omitempty"`
}

type PeerInfo struct {
	Fingerprint string                 `json:"fingerprint"`
	Alias       string                 `json:"alias,omitempty"`
	AppType     string                 `json:"app_type,omitempty"`
	Meta        map[string]interface{} `json:"meta,omitempty"`
}

type PeerListPayload struct {
	Namespace string     `json:"namespace"`
	Peers     []PeerInfo `json:"peers"`
	Total     int        `json:"total"`
}

type MatchPayload struct {
	Namespace string                 `json:"namespace"`
	Criteria  map[string]interface{} `json:"criteria,omitempty"`
	GroupSize int                    `json:"group_size,omitempty"`
}

type MatchedPayload struct {
	Namespace string     `json:"namespace"`
	Peers     []PeerInfo `json:"peers"`
	SessionID string     `json:"session_id"`
}

type ErrorPayload struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type BroadcastPayload struct {
	Namespace string              `json:"namespace"`
	Data      jsoniter.RawMessage `json:"data"`
	Exclude   []string            `json:"exclude,omitempty"`
}

type MetadataPayload struct {
	Meta map[string]interface{} `json:"meta"`
}

type CreateRoomPayload struct {
	RoomID  string `json:"room_id"`
	MaxSize int    `json:"max_size,omitempty"`
}

type RoomCreatedPayload struct {
	RoomID  string `json:"room_id"`
	MaxSize int    `json:"max_size"`
	Owner   string `json:"owner"`
}

type JoinRoomPayload struct {
	RoomID string `json:"room_id"`
}

type RoomInfoPayload struct {
	RoomID    string `json:"room_id"`
	PeerCount int    `json:"peer_count"`
	MaxSize   int    `json:"max_size"`
	Owner     string `json:"owner"`
}

type RoomClosedPayload struct {
	RoomID string `json:"room_id"`
	Reason string `json:"reason"`
}

type KickPayload struct {
	RoomID      string `json:"room_id"`
	Fingerprint string `json:"fingerprint"`
}

func Encode(msg *Message) ([]byte, error) {
	return json.Marshal(msg)
}

func Decode(data []byte) (*Message, error) {
	msg := AcquireMessage()
	err := json.Unmarshal(data, msg)
	return msg, err
}

func NewError(code int, message string) *Message {
	payload, _ := json.Marshal(ErrorPayload{Code: code, Message: message})
	return &Message{Type: TypeError, Payload: payload}
}

func NewMessage(typ string, from string, payload interface{}) *Message {
	data, _ := json.Marshal(payload)
	return &Message{Type: typ, From: from, Payload: data}
}

// pre-encoded common responses
var (
	PongBytes      []byte
	RateLimitBytes []byte
)

func init() {
	PongBytes, _ = json.Marshal(&Message{Type: TypePong})
	RateLimitBytes, _ = json.Marshal(NewError(429, "rate limited"))
}
