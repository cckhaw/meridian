// Rating & charging gateway: the hot path for online charging (Diameter Gy / 5G CHF Nchf).
// Scaffold only: an in-memory balance store behind the same interface the Redis Cluster
// implementation will satisfy. Reservations are idempotent per (sessionId, requestNumber).
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sync"
)

type Reservation struct {
	SessionID  string `json:"sessionId"`
	RequestNo  int    `json:"requestNumber"`
	Subscriber string `json:"subscriber"`
	Units      int64  `json:"units"` // minor currency units or bytes, per rating group
}

var ErrInsufficient = errors.New("insufficient balance")

type BalanceStore interface {
	Reserve(r Reservation) (granted int64, err error)
}

type memStore struct {
	mu      sync.Mutex
	balance map[string]int64
	seen    map[string]int64 // idempotency: sessionId#requestNo -> granted
}

func (m *memStore) Reserve(r Reservation) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := fmt.Sprintf("%s#%d", r.SessionID, r.RequestNo)
	if g, ok := m.seen[key]; ok {
		return g, nil
	}
	bal := m.balance[r.Subscriber]
	if bal <= 0 {
		return 0, ErrInsufficient
	}
	g := min(bal, r.Units) // partial grant, as CCR final-unit handling would
	m.balance[r.Subscriber] = bal - g
	m.seen[key] = g
	return g, nil
}

func main() {
	var store BalanceStore = &memStore{balance: map[string]int64{"+6591234567": 10_000}, seen: map[string]int64{}}
	http.HandleFunc("/v1/reserve", func(w http.ResponseWriter, req *http.Request) {
		var r Reservation
		if err := json.NewDecoder(req.Body).Decode(&r); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		g, err := store.Reserve(r)
		if errors.Is(err, ErrInsufficient) {
			http.Error(w, err.Error(), http.StatusPaymentRequired)
			return
		}
		json.NewEncoder(w).Encode(map[string]int64{"granted": g})
	})
	http.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	log.Fatal(http.ListenAndServe(":4003", nil))
}
