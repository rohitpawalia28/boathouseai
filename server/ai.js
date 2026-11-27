// AI provider adapter. Business logic only talks to { generate({system, contents, tools}) }.
// To add Ollama / Groq later, write another provider with the same shape.

export function geminiProvider({ apiKey, model }) {
  return {
    name: 'gemini',
    async generate({ system, contents, tools }) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        // no tools (for example a plain key test) = a plain text answer
        ...(tools?.length ? { tools: [{ functionDeclarations: tools }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } } : {}),
        generationConfig: { temperature: 0.2 },
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        const err = new Error(`Gemini HTTP ${res.status}`);
        err.status = res.status;
        err.detail = (await res.text()).slice(0, 400);
        throw err;
      }
      const data = await res.json();
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      return {
        // Keep the model's parts exactly as returned (Gemini needs them back, incl. thought signatures).
        parts,
        text: parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim(),
        functionCalls: parts.filter((p) => p.functionCall).map((p) => p.functionCall),
      };
    },
    // Speech to text with Gemini. Much better at Hindi / Hinglish than the browser's own recogniser.
    async transcribe({ audioBase64, mime, hints = [] }) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const prompt = `Transcribe this audio exactly as spoken. The speaker is a houseboat owner in India talking about bookings and money, in Hindi, English or a mix (Hinglish).
Write the transcript in English letters only (Roman script): Hindi words spelled the way people type Hinglish (for example "mere paas chaar room hain"), English words as normal English. Never use Devanagari.
Write numbers as digits ("do december" = 2 December, "chaar rooms" = 4 rooms, "paanch hazaar" = 5000). Meal plan codes are EP, CP, MAP, AP. Room tokens look like CUL001.${hints.length ? ` Houseboat names that may be spoken: ${hints.join(', ')}.` : ''}
Do not translate, do not answer, do not add notes. Output only the transcript. If there is no speech, output nothing.`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: audioBase64 } }] }], generationConfig: { temperature: 0 } }),
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok) {
        const err = new Error(`Gemini HTTP ${res.status}`);
        err.status = res.status;
        err.detail = (await res.text()).slice(0, 400);
        throw err;
      }
      const data = await res.json();
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      return parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim();
    },
  };
}
