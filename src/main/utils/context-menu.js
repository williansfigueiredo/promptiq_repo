// ============================================================
// context-menu.js
// ============================================================
// DESCRIÇÃO: Gerenciador de menu de contexto (clique direito)
// FUNÇÃO: Cria um menu de contexto personalizado para janelas
//         do Electron com sugestões de correção ortográfica,
//         opções de copiar/colar e outras ações de edição.
// ============================================================

const { Menu } = require('electron');

/**
 * attachContextMenu
 * ------------------
 * Anexa um menu de contexto personalizado a uma janela do Electron.
 * 
 * Funcionalidades:
 * - Mostra sugestões de correção ortográfica quando há palavra errada
 * - Permite adicionar palavras ao dicionário do usuário
 * - Inclui opções padrão: Desfazer, Refazer, Recortar, Copiar, Colar, Selecionar Tudo
 * 
 * @param {BrowserWindow} win - Janela do Electron onde anexar o menu
 */
function attachContextMenu(win) {
    // ========================================
    // LISTENER: Detecta clique direito na janela
    // ========================================
    win.webContents.on('context-menu', (event, params) => {
        const menuTemplate = [];
        
        // ========================================
        // SEÇÃO 0: IR PARA OPERATOR (quando há seleção)
        // ========================================
        if (params.selectionText && params.selectionText.trim().length > 0) {
            menuTemplate.push({
                label: 'Go to Operator',
                click: () => win.webContents.send('go-to-operator-at-selection')
            });
            menuTemplate.push({ type: 'separator' });
        }
        
        // ========================================
        // SEÇÃO 1: CORREÇÃO ORTOGRÁFICA
        // ========================================
        // Se a palavra sob o cursor está marcada como errada
        if (params.misspelledWord) {
            // Se há sugestões de correção disponíveis
            if (params.dictionarySuggestions.length > 0) {
                // Detecta o case da palavra original
                const originalWord = params.misspelledWord;
                
                // Conta quantas letras são maiúsculas vs minúsculas
                const letters = originalWord.replace(/[^a-zA-ZÀ-ÿ]/g, '');
                const upperCount = (letters.match(/[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÀÈÌÒÙÄËÏÖÜÇ]/g) || []).length;
                const lowerCount = (letters.match(/[a-záéíóúâêîôûãõàèìòùäëïöüç]/g) || []).length;
                
                // Se maioria é maiúscula (>70%), trata como MAIÚSCULA
                const isMostlyUpperCase = letters.length > 0 && (upperCount / letters.length) >= 0.7;
                const isAllUpperCase = originalWord === originalWord.toUpperCase();
                const isTitleCase = !isMostlyUpperCase && 
                                    originalWord[0] === originalWord[0].toUpperCase() && 
                                    originalWord.slice(1) === originalWord.slice(1).toLowerCase();
                
                // Adiciona cada sugestão como item clicável
                params.dictionarySuggestions.forEach(suggestion => {
                    // Aplica o mesmo case da palavra original à sugestão
                    let casedSuggestion = suggestion;
                    if (isAllUpperCase || isMostlyUpperCase) {
                        casedSuggestion = suggestion.toUpperCase();
                    } else if (isTitleCase) {
                        casedSuggestion = suggestion.charAt(0).toUpperCase() + suggestion.slice(1).toLowerCase();
                    }
                    
                    menuTemplate.push({ 
                        label: casedSuggestion, 
                        click: () => win.webContents.replaceMisspelling(casedSuggestion) 
                    });
                });
            } else { 
                // Nenhuma sugestão encontrada
                menuTemplate.push({ label: '(Sem sugestões)', enabled: false }); 
            }
            
            // Separador visual
            menuTemplate.push({ type: 'separator' });
            
            // Opção para adicionar a palavra ao dicionário do usuário
            menuTemplate.push({ 
                label: 'Adicionar ao dicionário', 
                click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) 
            });
            
            // Separador antes das opções padrão
            menuTemplate.push({ type: 'separator' });
        }
        
        // ========================================
        // SEÇÃO 2: OPÇÕES PADRÃO DE EDIÇÃO
        // ========================================
        menuTemplate.push(
            { role: 'undo', label: 'Desfazer' },       // Ctrl+Z
            { role: 'redo', label: 'Refazer' },        // Ctrl+Y
            { type: 'separator' },
            { role: 'cut', label: 'Recortar' },        // Ctrl+X
            { role: 'copy', label: 'Copiar' },         // Ctrl+C
            { role: 'paste', label: 'Colar' },         // Ctrl+V
            { role: 'selectAll', label: 'Selecionar Tudo' }  // Ctrl+A
        );
        
        // ========================================
        // EXIBE O MENU NA POSIÇÃO DO CURSOR
        // ========================================
        const menu = Menu.buildFromTemplate(menuTemplate);
        menu.popup();
    });
}

// ============================================================
// EXPORTAÇÃO DO MÓDULO
// ============================================================
module.exports = {
    attachContextMenu
};
