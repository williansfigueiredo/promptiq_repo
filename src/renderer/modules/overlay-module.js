// js/overlay-renderer.js (CÓDIGO COMPLETO E FINAL - Com correção de Bloqueio de Mouse/Fechamento)

const { ipcRenderer } = require('electron'); 

document.addEventListener('DOMContentLoaded', () => {
    const lupaCirculo = document.getElementById('lupa-circulo');
    if (!lupaCirculo) return;

    let animationFrameId = null;
    // Função que atualiza a posição do círculo com base nas coordenadas do mouse
    function updateLupaPosition(e) {
        // OTIMIZAÇÃO: Se já houver um quadro agendado, cancela para evitar sobrecarga visual
        if (animationFrameId) cancelAnimationFrame(animationFrameId);

        // OTIMIZAÇÃO: Agenda a atualização visual para o próximo ciclo de pintura da tela (60fps)
        animationFrameId = requestAnimationFrame(() => {
            lupaCirculo.style.left = `${e.clientX}px`;
            lupaCirculo.style.top = `${e.clientY}px`;
            animationFrameId = null;
        });
    }

    // Adiciona o listener para rastrear o movimento do mouse na janela do overlay
    window.addEventListener('mousemove', updateLupaPosition, { passive: true });
    
    // ✅ CORREÇÃO CRÍTICA: Removido o mousedown, que estava interferindo no sistema.
    // A LUPA AGORA SÓ FECHA PELO DUPLO CTRL (que dispara toggle-overlay)

    // Adicionamos um atalho de teclado na janela do overlay para fechar de forma garantida.
    window.addEventListener('keydown', (e) => {
        // Usa a tecla ESC (27) como fallback profissional para fechar overlays.
        if (e.keyCode === 27 || e.key === 'Escape') { 
            ipcRenderer.send('toggle-overlay');
        }
    });

    document.body.classList.add('overlay-active');
});
