// ============================================================
// license.config.js
// ============================================================
// DESCRIÇÃO: Configurações centrais do módulo de licenciamento.
// EDITAR AQUI: troque LICENSE_API_URL quando seu ERP estiver online.
//
// DESENVOLVIMENTO (npm start / Electron não empacotado):
//   - Por padrão a licença NÃO bloqueia o boot (trabalho local).
//   - Para testar splash + janela de ativação + ERP: defina a variável
//     de ambiente PROMPTIQ_ENFORCE_LICENSE=1 antes de iniciar.
//     PowerShell:  $env:PROMPTIQ_ENFORCE_LICENSE='1'; npm start
//     CMD:         set PROMPTIQ_ENFORCE_LICENSE=1 && npm start
//   - Com enforce ligado, sem ERP: use a chave DEV-LOCAL-PROMPTIQ na
//     tela de ativação (só em dev; builds .exe ignoram este atalho).
// ============================================================

module.exports = {
  // URL do endpoint do ERP que recebe a chave + fingerprint.
  // O servidor deve responder JSON no formato:
  //   { valid: true, customer: "Nome", token: "...", meta: {...} }
  //   ou { valid: false, message: "motivo" }
  LICENSE_API_URL: 'https://license.promptiq.com.br/api/v1/license/activate',

  // Tempo máximo de espera da resposta do ERP (ms)
  REQUEST_TIMEOUT_MS: 10000,

  // Nome do arquivo de licença cifrado (gravado em userData/)
  LICENSE_FILE_NAME: 'license.dat',

  // Versão do app enviada ao ERP (para logs no servidor)
  APP_VERSION: '1.3.5'
};
