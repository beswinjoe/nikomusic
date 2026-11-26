package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDisabledWithoutKeys(t *testing.T) {
	rec := NewRecommender(Config{})
	if rec.Enabled() {
		t.Fatal("expected recommender disabled when no API keys set")
	}
	resp, err := rec.Recommend(context.Background(), RecommendRequest{
		Mode:      "discovery",
		TopTracks: []TrackHint{{Title: "The Wind", Artist: "John Michael Howell"}},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Enabled || len(resp.Queries) != 0 {
		t.Fatalf("expected empty disabled response, got %+v", resp)
	}
}

func TestParseRecommendationJSONStripsCodeFencesAndDeduplicates(t *testing.T) {
	raw := "```json\n{\"queries\":[\"SZA - Snooze\",\"  sza - snooze \",\"Frank Ocean - Pink + White\"],\"artists\":[\"SZA\",\"Frank Ocean\"],\"avoidKeywords\":[\"nightcore\"]}\n```"
	parsed, err := ParseRecommendationJSON(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(parsed.Queries) != 2 {
		t.Fatalf("expected deduplicated 2 queries, got %v", parsed.Queries)
	}
	if parsed.Artists[0] != "SZA" || parsed.AvoidKeywords[0] != "nightcore" {
		t.Fatalf("unexpected parsed fields: %+v", parsed)
	}
}

func TestGeminiRecommendRoundTrip(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "gemini-2.5-flash:generateContent") || r.URL.Query().Get("key") != "secret-key" {
			t.Fatalf("unexpected gemini path/query: %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"candidates": []map[string]any{
				{
					"content": map[string]any{
						"parts": []map[string]string{
							{"text": `{"queries":["Daniel Caesar - Get You","Giveon - Heartbreak Anniversary"],"artists":["Daniel Caesar","Giveon"]}`},
						},
					},
				},
			},
		})
	}))
	defer srv.Close()

	rec := NewRecommender(Config{
		GeminiAPIKey:  "secret-key",
		GeminiBaseURL: srv.URL,
	})
	if !rec.Enabled() {
		t.Fatal("expected enabled")
	}
	resp, err := rec.Recommend(context.Background(), RecommendRequest{
		Mode:         "discovery",
		Mood:         "Late Night",
		TopTracks:    []TrackHint{{Title: "Low", Artist: "SZA"}},
		LikedArtists: []string{"SZA"},
		Audio:        &AudioSignature{AvgBPM: 96, AvgEnergy: 0.52, TopKeys: []string{"8A"}},
	})
	if err != nil {
		t.Fatalf("recommend error: %v", err)
	}
	if !resp.Enabled || resp.Provider != "gemini" || len(resp.Queries) != 2 || len(resp.Artists) != 2 {
		t.Fatalf("unexpected response: %+v", resp)
	}
}

func TestOpenAIRecommendRoundTrip(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer openai-secret" {
			t.Fatalf("unexpected openai call: %s %s", r.URL.Path, r.Header.Get("Authorization"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{
				{
					"message": map[string]string{
						"content": `{"queries":["Lauv - I Like Me Better"],"artists":["Lauv"],"subgenres":["indie pop"],"tasteSummary":"Smooth melodic indie pop around 95 BPM"}`,
					},
				},
			},
		})
	}))
	defer srv.Close()

	rec := NewRecommender(Config{
		OpenAIAPIKey:  "openai-secret",
		OpenAIBaseURL: srv.URL,
	})
	resp, err := rec.Recommend(context.Background(), RecommendRequest{
		Mode:                 "new-release",
		LikedArtists:         []string{"John Michael Howell"},
		PriorPersona:         "Melodic pop-soul",
		LikedRecommendations: []TrackHint{{Title: "The Wind", Artist: "John Michael Howell"}},
	})
	if err != nil {
		t.Fatalf("recommend error: %v", err)
	}
	if !resp.Enabled || resp.Provider != "openai" || resp.Queries[0] != "Lauv - I Like Me Better" || resp.TasteSummary == "" {
		t.Fatalf("unexpected response: %+v", resp)
	}
}
