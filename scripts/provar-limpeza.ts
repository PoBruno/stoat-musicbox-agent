import { limparRestosDeExtracao } from "../src/limpeza.ts";

const n = await limparRestosDeExtracao();
console.log(`removidas: ${n}`);
