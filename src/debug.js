const Groq = require("groq-sdk");

const client = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const SYSTEM_PROMPT = `Você é o DebugAI, um assistente especializado em ajudar desenvolvedores a entender e corrigir erros de código.

Suas regras absolutas:
- Sempre responda em português brasileiro, de forma clara e direta
- Nunca invente soluções que você não tem certeza
- Analise o erro e o código fornecido especificamente

Estrutura obrigatória de toda resposta:

## O que causou esse erro
[Explique em 2-4 frases o que deu errado e por quê]

## Como corrigir
[Mostre o código corrigido com comentários]

## Cuidados relacionados
[1-3 dicas sobre erros similares]`;

async function debugCode({ linguagem, erro, codigo, contexto }) {
  const userMessage = `
**Linguagem/Framework:** ${linguagem || "não especificada"}

**Mensagem de erro:**
\`\`\`
${erro}
\`\`\`

**Código onde o erro ocorre:**
\`\`\`${linguagem || ""}
${codigo || "Não fornecido"}
\`\`\`

**Contexto adicional:**
${contexto || "Nenhum contexto adicional."}
  `.trim();

  const response = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 1024,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
  });

  return response.choices[0].message.content;
}

module.exports = { debugCode };
