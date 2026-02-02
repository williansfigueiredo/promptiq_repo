// js/keyboard-handler.js (CÓDIGO COMPLETO E CORRIGIDO PARA FOCO LOCAL)

const { ipcRenderer } = require('electron');

let lastCtrlPress = 0;
const doubleClickThreshold = 220; 
let ctrlTimeout = null;

// Mudamos de 'keydown' (tecla pressionada) para 'keyup' (tecla solta) para melhor estabilidade
document.addEventListener('keyup', (e) => {
    // Código 17 é a tecla Ctrl
    if (e.keyCode === 17 || e.key === 'Control') {
        
        // 1. VERIFICAÇÃO DE FOCO (Otimização): 
        // Embora o ambiente Renderer só detecte quando focado, esta é uma camada extra de segurança.
        // Se o evento não estiver vindo do corpo principal do documento, ignora.
        if (document.activeElement && document.activeElement.tagName === 'BODY' || 
            document.activeElement.tagName === 'TEXTAREA') {
            
            const now = Date.now();
            
            // 2. Verifica se houve um clique anterior recente
            if (now - lastCtrlPress < doubleClickThreshold) {
                
                // É um duplo clique válido!
                if (ctrlTimeout) clearTimeout(ctrlTimeout);
                
                // Envia o comando de alternar (toggle)
                ipcRenderer.send('toggle-overlay');
                
                lastCtrlPress = 0; 
                
                e.preventDefault(); 
                e.stopPropagation(); 
                return;
            }
            
            // 3. Se for o PRIMEIRO clique:
            if (ctrlTimeout) clearTimeout(ctrlTimeout);

            lastCtrlPress = now;
            
            ctrlTimeout = setTimeout(() => {
                lastCtrlPress = 0;
                ctrlTimeout = null;
            }, doubleClickThreshold);
            
            e.preventDefault(); 
            e.stopPropagation();
        }
    }
});
