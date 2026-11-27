package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	defaultGeminiURL = "https://generativelanguage.googleapis.com"
	defaultOpenAIURL = "https://api.openai.com/v1"
	maxResponseBytes = 256 * 1024
)

// TrackHint describes a compact listener track signal sent by a client.
type TrackHint struct {
	Title  string `json:"title"`
	Artist string `json:"artist"`
}

// AudioSignature summarizes cached acoustic preferences from AutoMix analyses.
type AudioSignature struct {
	AvgBPM    float64  `json:"avgBpm,omitempty"`
	AvgEnergy float64  `json:"avgEnergy,omitempty"`
	TopKeys   []string `json:"topKeys,omitempty"`
}

// RecommendRequest carries a compact listener taste summary (never raw UI prompts).
type RecommendRequest struct {
	Mode                   string          `json:"mode"`
	Mood                   string          `json:"mood,omitempty"`
	TopTracks              []TrackHint     `json:"topTracks,omitempty"`
	LikedArtists           []string        `json:"likedArtists,omitempty"`
	SkippedArtists         []string        `json:"skippedArtists,omitempty"`
	LikedRecommendations   []TrackHint     `json:"likedRecommendations,omitempty"`
	SkippedRecommendations []TrackHint     `json:"skippedRecommendations,omitempty"`
	PreferredGenres        []string        `json:"preferredGenres,omitempty"`
	PreferredMoods         []string        `json:"preferredMoods,omitempty"`
	ListeningPattern       string          `json:"listeningPattern,omitempty"`
	PriorPersona           string          `json:"priorPersona,omitempty"`
	PreferredScripts       []string        `json:"preferredScripts,omitempty"`
	ExplorationRatio       float64         `json:"explorationRatio,omitempty"`
	Audio                  *AudioSignature `json:"audio,omitempty"`
}

// RecommendResponse contains AI-curated discovery queries executed quietly in the background.
type RecommendResponse struct {
	Enabled       bool     `json:"enabled"`
	Provider      string   `json:"provider,omitempty"`
	Queries       []string `json:"queries"`
	Artists       []string `json:"artists"`
	Subgenres     []string `json:"subgenres,omitempty"`
	AvoidKeywords []string `json:"avoidKeywords,omitempty"`
	TasteSummary  string   `json:"tasteSummary,omitempty"`
	Reasons       []string `json:"reasons,omitempty"`
}

// Config configures the server-only AI provider (from server env vars only).
type Config struct {
	GeminiAPIKey  string
	GeminiModel   string
	GeminiBaseURL string
	OpenAIAPIKey  string
	OpenAIBaseURL string
	OpenAIModel   string
	Timeout       time.Duration
}

// Recommender calls an upstream LLM solely from backend credentials.
type Recommender struct {
	cfg    Config
	client *http.Client
}

// NewRecommender returns a server-only Recommender using stdlib HTTP.
func NewRecommender(cfg Config) *Recommender {
	if cfg.GeminiModel == "" {
		cfg.GeminiModel = "gemini-2.5-flash"
	}
	if cfg.GeminiBaseURL == "" {
		cfg.GeminiBaseURL = defaultGeminiURL
	}
	if cfg.OpenAIBaseURL == "" {
		cfg.OpenAIBaseURL = defaultOpenAIURL
	}
	if cfg.OpenAIModel == "" {
		cfg.OpenAIModel = "gpt-4o-mini"
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &Recommender{
		cfg:    cfg,
		client: &http.Client{Timeout: timeout},
	}
}

// Enabled reports whether a server-side AI credential is configured.
func (r *Recommender) Enabled() bool {
	if r == nil {
		return false
	}
	return strings.TrimSpace(r.cfg.GeminiAPIKey) != "" || strings.TrimSpace(r.cfg.OpenAIAPIKey) != ""
}

// Recommend generates background discovery search seeds aligned with the listener's taste.
func (r *Recommender) Recommend(ctx context.Context, req RecommendRequest) (RecommendResponse, error) {
	if !r.Enabled() {
		return RecommendResponse{Enabled: false, Queries: []string{}, Artists: []string{}}, nil
	}
	sanitized := sanitizeRequest(req)
	if len(sanitized.TopTracks) == 0 && len(sanitized.LikedArtists) == 0 {
		return RecommendResponse{Enabled: true, Queries: []string{}, Artists: []string{}}, nil
	}
	prompt := BuildPrompt(sanitized)

	var (
		rawText  string
		provider string
		err      error
	)
	if strings.TrimSpace(r.cfg.GeminiAPIKey) != "" {
		provider = "gemini"
		rawText, err = r.callGemini(ctx, prompt)
	} else {
		provider = "openai"
		rawText, err = r.callOpenAI(ctx, prompt)
	}
	if err != nil {
		return RecommendResponse{}, err
	}
	parsed, err := ParseRecommendationJSON(rawText)
	if err != nil {
		return RecommendResponse{}, err
	}
	parsed.Enabled = true
	parsed.Provider = provider
	return parsed, nil
}

func (r *Recommender) callGemini(ctx context.Context, prompt string) (string, error) {
	base := strings.TrimRight(r.cfg.GeminiBaseURL, "/")
	endpoint := fmt.Sprintf("%s/v1beta/models/%s:generateContent?key=%s", base, r.cfg.GeminiModel, r.cfg.GeminiAPIKey)

	payload := map[string]any{
		"contents": []map[string]any{
			{
				"role":  "user",
				"parts": []map[string]string{{"text": prompt}},
			},
		},
		"generationConfig": map[string]any{
			"temperature":      0.85,
			"maxOutputTokens":  700,
			"responseMimeType": "application/json",
		},
	}
	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := r.client.Do(httpReq)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("gemini status %d", resp.StatusCode)
	}
	var decoded struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return "", err
	}
	if len(decoded.Candidates) == 0 || len(decoded.Candidates[0].Content.Parts) == 0 {
		return "", errors.New("empty gemini response")
	}
	return decoded.Candidates[0].Content.Parts[0].Text, nil
}

func (r *Recommender) callOpenAI(ctx context.Context, prompt string) (string, error) {
	base := strings.TrimRight(r.cfg.OpenAIBaseURL, "/")
	endpoint := base + "/chat/completions"

	payload := map[string]any{
		"model":       r.cfg.OpenAIModel,
		"temperature": 0.85,
		"response_format": map[string]string{
			"type": "json_object",
		},
		"messages": []map[string]string{
			{
				"role":    "system",
				"content": "Return strict JSON matching the requested schema.",
			},
			{
				"role":    "user",
				"content": prompt,
			},
		},
	}
	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+r.cfg.OpenAIAPIKey)

	resp, err := r.client.Do(httpReq)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("openai status %d", resp.StatusCode)
	}
	var decoded struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return "", err
	}
	if len(decoded.Choices) == 0 {
		return "", errors.New("empty openai response")
	}
	return decoded.Choices[0].Message.Content, nil
}

// BuildPrompt turns a sanitized listener taste summary into a structured curation prompt.
func BuildPrompt(req RecommendRequest) string {
	var b strings.Builder
	b.WriteString("You are an expert music discovery curator powering the background recommendation engine of a music streaming app.\n")
	b.WriteString("Recommend genuinely NEW or adjacent songs & artists that match the listener's real taste while avoiding repeated tracks they already hear or artists they skip.\n\n")
	if req.Mode != "" {
		fmt.Fprintf(&b, "Station mode: %s\n", req.Mode)
	}
	if req.Mood != "" {
		fmt.Fprintf(&b, "Current mood target: %s\n", req.Mood)
	}
	if req.PriorPersona != "" {
		fmt.Fprintf(&b, "Prior learned taste summary (refine from new feedback): %s\n", req.PriorPersona)
	}
	if len(req.TopTracks) > 0 {
		b.WriteString("Listener favourite/completed tracks:\n")
		for _, t := range req.TopTracks {
			if t.Artist != "" {
				fmt.Fprintf(&b, "- %s — %s\n", t.Title, t.Artist)
			} else {
				fmt.Fprintf(&b, "- %s\n", t.Title)
			}
		}
	}
	if len(req.LikedArtists) > 0 {
		fmt.Fprintf(&b, "Top liked artists: %s\n", strings.Join(req.LikedArtists, ", "))
	}
	if len(req.LikedRecommendations) > 0 {
		b.WriteString("Previous recommendations the listener LOVED/completed (do more like these):\n")
		for _, t := range req.LikedRecommendations {
			fmt.Fprintf(&b, "- %s — %s\n", t.Title, t.Artist)
		}
	}
	if len(req.SkippedRecommendations) > 0 {
		b.WriteString("Previous recommendations the listener SKIPPED early (steer away from these styles):\n")
		for _, t := range req.SkippedRecommendations {
			fmt.Fprintf(&b, "- %s — %s\n", t.Title, t.Artist)
		}
	}
	if len(req.SkippedArtists) > 0 {
		fmt.Fprintf(&b, "Artists recently skipped early (avoid): %s\n", strings.Join(req.SkippedArtists, ", "))
	}
	if len(req.PreferredGenres) > 0 {
		fmt.Fprintf(&b, "Preferred genres: %s\n", strings.Join(req.PreferredGenres, ", "))
	}
	if len(req.PreferredMoods) > 0 {
		fmt.Fprintf(&b, "Preferred moods: %s\n", strings.Join(req.PreferredMoods, ", "))
	}
	if req.ListeningPattern != "" {
		fmt.Fprintf(&b, "Typical listening rhythm: %s\n", req.ListeningPattern)
	}
	if len(req.PreferredScripts) > 0 {
		fmt.Fprintf(&b, "Preferred language/script cues: %s\n", strings.Join(req.PreferredScripts, ", "))
	}
	if req.ExplorationRatio > 0 {
		fmt.Fprintf(&b, "Target novelty balance: ~%.0f%% unfamiliar artists/tracks, ~%.0f%% deeper cuts from compatible scenes\n",
			req.ExplorationRatio*100, (1.0-req.ExplorationRatio)*100)
	}
	if req.Audio != nil && req.Audio.AvgBPM > 0 {
		fmt.Fprintf(&b, "Acoustic sweet spot: ~%.0f BPM, energy %.2f/1.00", req.Audio.AvgBPM, req.Audio.AvgEnergy)
		if len(req.Audio.TopKeys) > 0 {
			fmt.Fprintf(&b, ", harmonic keys %s", strings.Join(req.Audio.TopKeys, ", "))
		}
		b.WriteByte('\n')
	}
	b.WriteString("\nRules:\n")
	b.WriteString("1. Never include fan reuploads, lyric channels (like 7clouds), slowed+reverb, or sped-up remixes.\n")
	b.WriteString("2. Queries should be clean official artist/track pairs like \"Artist Song Title\" suitable for searching YouTube Music Songs.\n")
	b.WriteString("3. Do not repeat tracks already listed in favourite tracks above; pick adjacent/new releases or deep-cut gems matching the same sonic feel.\n")
	b.WriteString("4. Spread queries across distinct artists and subgenres instead of repeating one artist twice.\n")
	b.WriteString("5. Update \"tasteSummary\" cleanly in <= 180 chars reflecting what this listener responds to.\n")
	b.WriteString("6. Optionally provide concise short labels in \"reasons\" (aligned 1-to-1 with \"queries\", max 6 words each) explaining why each fit the listener.\n")
	b.WriteString("7. Return JSON ONLY with keys:\n")
	b.WriteString(`   {"queries": [8 to 10 "Artist - Track" strings], "artists": [6 to 8 recommended artist names], "subgenres": [3 to 5 concise subgenres], "avoidKeywords": [optional up to 6 mismatched subgenres], "tasteSummary": "<concise evolved taste persona>", "reasons": [optional concise reasons matching queries]}`)
	return b.String()
}

// ParseRecommendationJSON parses structured LLM output, stripping markdown wrappers if present.
func ParseRecommendationJSON(raw string) (RecommendResponse, error) {
	cleaned := strings.TrimSpace(raw)
	if strings.HasPrefix(cleaned, "```") {
		if idx := strings.IndexByte(cleaned, '\n'); idx >= 0 {
			cleaned = cleaned[idx+1:]
		}
		if end := strings.LastIndex(cleaned, "```"); end >= 0 {
			cleaned = cleaned[:end]
		}
		cleaned = strings.TrimSpace(cleaned)
	}
	if start := strings.IndexByte(cleaned, '{'); start >= 0 {
		if end := strings.LastIndexByte(cleaned, '}'); end > start {
			cleaned = cleaned[start : end+1]
		}
	}

	var parsed struct {
		Queries       []string `json:"queries"`
		Artists       []string `json:"artists"`
		Subgenres     []string `json:"subgenres"`
		AvoidKeywords []string `json:"avoidKeywords"`
		TasteSummary  string   `json:"tasteSummary"`
		Reasons       []string `json:"reasons"`
	}
	if err := json.Unmarshal([]byte(cleaned), &parsed); err != nil {
		return RecommendResponse{}, err
	}
	return RecommendResponse{
		Queries:       cleanList(parsed.Queries, 10, 96),
		Artists:       cleanList(parsed.Artists, 8, 64),
		Subgenres:     cleanList(parsed.Subgenres, 6, 48),
		AvoidKeywords: cleanList(parsed.AvoidKeywords, 6, 48),
		TasteSummary:  clampText(parsed.TasteSummary, 200),
		Reasons:       cleanRawList(parsed.Reasons, 10, 72),
	}, nil
}

func sanitizeHints(items []TrackHint, limit int) []TrackHint {
	out := make([]TrackHint, 0, min(limit, len(items)))
	for _, t := range items {
		title := clampText(t.Title, 80)
		artist := clampText(t.Artist, 64)
		if title == "" {
			continue
		}
		out = append(out, TrackHint{Title: title, Artist: artist})
		if len(out) >= limit {
			break
		}
	}
	return out
}

func sanitizeRequest(req RecommendRequest) RecommendRequest {
	ratio := req.ExplorationRatio
	if ratio < 0 {
		ratio = 0
	} else if ratio > 0.95 {
		ratio = 0.95
	}
	out := RecommendRequest{
		Mode:                   clampText(req.Mode, 24),
		Mood:                   clampText(req.Mood, 40),
		PriorPersona:           clampText(req.PriorPersona, 220),
		ListeningPattern:       clampText(req.ListeningPattern, 64),
		ExplorationRatio:       ratio,
		TopTracks:              sanitizeHints(req.TopTracks, 12),
		LikedRecommendations:   sanitizeHints(req.LikedRecommendations, 8),
		SkippedRecommendations: sanitizeHints(req.SkippedRecommendations, 8),
		LikedArtists:           cleanList(req.LikedArtists, 10, 64),
		SkippedArtists:         cleanList(req.SkippedArtists, 10, 64),
		PreferredGenres:        cleanList(req.PreferredGenres, 8, 40),
		PreferredMoods:         cleanList(req.PreferredMoods, 6, 32),
		PreferredScripts:       cleanList(req.PreferredScripts, 5, 24),
	}
	if req.Audio != nil && req.Audio.AvgBPM >= 40 && req.Audio.AvgBPM <= 240 {
		sig := &AudioSignature{
			AvgBPM:    req.Audio.AvgBPM,
			AvgEnergy: req.Audio.AvgEnergy,
			TopKeys:   cleanList(req.Audio.TopKeys, 4, 16),
		}
		if sig.AvgEnergy < 0 {
			sig.AvgEnergy = 0
		} else if sig.AvgEnergy > 1 {
			sig.AvgEnergy = 1
		}
		out.Audio = sig
	}
	return out
}

func cleanList(items []string, limit, maxLen int) []string {
	out := make([]string, 0, min(limit, len(items)))
	seen := make(map[string]struct{}, limit)
	for _, item := range items {
		v := clampText(item, maxLen)
		if v == "" {
			continue
		}
		key := strings.ToLower(v)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, v)
		if len(out) >= limit {
			break
		}
	}
	return out
}

// cleanRawList trims items without deduplicating so positional alignment (such as Reasons) stays intact.
func cleanRawList(items []string, limit, maxLen int) []string {
	out := make([]string, 0, min(limit, len(items)))
	for _, item := range items {
		v := clampText(item, maxLen)
		if v == "" {
			continue
		}
		out = append(out, v)
		if len(out) >= limit {
			break
		}
	}
	return out
}

func clampText(s string, maxLen int) string {
	s = strings.Join(strings.Fields(strings.TrimSpace(s)), " ")
	if s == "" {
		return ""
	}
	runes := []rune(s)
	if len(runes) > maxLen {
		return string(runes[:maxLen])
	}
	return s
}
