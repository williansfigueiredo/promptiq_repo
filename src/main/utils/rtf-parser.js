// ============================================================
// rtf-parser.js
// ============================================================
// DESCRIÇÃO: Parser robusto para extração de texto de arquivos RTF
// FUNÇÃO: Converte conteúdo RTF bruto em texto puro, removendo
//         todas as tags de formatação, tabelas de fontes, cores,
//         estilos e metadados do documento.
// ============================================================

/**
 * extractTextFromRtf
 * -------------------
 * Extrai texto limpo de um documento RTF (Rich Text Format).
 * 
 * O que faz:
 * - Remove códigos de controle RTF (\fonttbl, \colortbl, \stylesheet, etc.)
 * - Converte caracteres hexadecimais escapados (\'xx) para caracteres reais
 * - Preserva quebras de linha (\par, \line) e tabulações (\tab)
 * - Ignora grupos de controle aninhados (cabeçalhos, rodapés, imagens)
 * 
 * @param {string} rtf - Conteúdo RTF bruto
 * @returns {string} - Texto limpo sem formatação
 */
function extractTextFromRtf(rtf) {
    // Converte caracteres hexadecimais escapados para caracteres reais
    // Exemplo: \'e9 vira 'é'
    rtf = rtf.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    
    let text = "";           // Texto final acumulado
    let stack = 0;           // Contador de níveis de chaves {}
    let ignoreLevels = [];   // Níveis onde devemos ignorar o conteúdo
    let i = 0;               // Ponteiro de leitura

    // Percorre todo o conteúdo RTF caractere por caractere
    while (i < rtf.length) {
        let char = rtf[i];
        
        // ========================================
        // PROCESSAMENTO DE COMANDOS RTF (começam com \)
        // ========================================
        if (char === '\\') {
            let remaining = rtf.slice(i);
            let match = remaining.match(/^(\\[a-z]+|\\[^a-z])(-?\d*) ?/i);
            
            if (match) {
                let cmd = match[1];
                let len = match[0].length;
                
                // Lista de comandos que devem ser ignorados completamente
                // (seus grupos contêm metadados, não texto visível)
                if (['\\fonttbl', '\\colortbl', '\\stylesheet', '\\info', '\\listtable', '\\header', '\\footer', '\\*', '\\pict'].includes(cmd)) {
                    ignoreLevels.push(stack); 
                }
                
                // Se não estamos em um grupo ignorado, processa comandos especiais
                if (ignoreLevels.length === 0) {
                    if (cmd === '\\par' || cmd === '\\line') text += '\n';  // Quebra de linha
                    else if (cmd === '\\tab') text += '\t';                  // Tabulação
                }
                
                i += len;
                continue;
            } else {
                i++;
                continue;
            }
        }
        
        // ========================================
        // CONTROLE DE GRUPOS (chaves {})
        // ========================================
        if (char === '{') { 
            stack++; 
            i++; 
            continue; 
        }
        
        if (char === '}') {
            // Se estávamos ignorando este nível, para de ignorar
            if (ignoreLevels.length > 0 && stack === ignoreLevels[ignoreLevels.length - 1]) {
                ignoreLevels.pop();
            }
            stack--; 
            i++; 
            continue;
        }
        
        // ========================================
        // EXTRAÇÃO DE TEXTO VISÍVEL
        // ========================================
        // Só adiciona ao texto se não estamos em um grupo ignorado
        // e não é uma quebra de linha do arquivo fonte
        if (ignoreLevels.length === 0 && char !== '\r' && char !== '\n') { 
            text += char; 
        }
        
        i++;
    }
    
    // Remove linhas em branco duplicadas e retorna texto limpo
    return text.replace(/\n\s*\n/g, '\n').trim();
}

// ============================================================
// EXPORTAÇÃO DO MÓDULO
// ============================================================
module.exports = {
    extractTextFromRtf
};
