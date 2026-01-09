import OpenAI from "openai";

export async function extractMenuTextFromImageBuffer({ buffer, mimeType }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const e = new Error("Missing OPENAI_API_KEY in .env");
    e.statusCode = 500;
    throw e;
  }

  const client = new OpenAI({ apiKey });

  const base64 = buffer.toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Extract the menu text from this image. Return plain text only. " +
              "One menu item per line. Keep section headings as their own lines.",
          },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });

  return resp.choices?.[0]?.message?.content ?? "";
}
