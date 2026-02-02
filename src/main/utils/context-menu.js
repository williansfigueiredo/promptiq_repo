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
        // SEÇÃO 1: CORREÇÃO ORTOGRÁFICA
        // ========================================
        // Se a palavra sob o cursor está marcada como errada
        if (params.misspelledWord) {
            // Se há sugestões de correção disponíveis
            if (params.dictionarySuggestions.length > 0) {
                // Adiciona cada sugestão como item clicável
                params.dictionarySuggestions.forEach(suggestion => {
                    menuTemplate.push({ 
                        label: suggestion, 
                        click: () => win.webContents.replaceMisspelling(suggestion) 
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
