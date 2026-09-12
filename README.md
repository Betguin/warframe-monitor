<p align="center"><img src="icon.png" width="96" alt="Warframe Monitor"></p>

# Warframe Monitor

**Ainda em Alpha Test**

Notificador de preços do Warframe Market para Tampermonkey, com alertas no Discord.

Abra a página de um item ou faça uma busca em Contratos, defina seu preço máximo e ative o monitor.

## Instalar

1. Instale o [Tampermonkey](https://www.tampermonkey.net/) no navegador.
2. Abra o [script para instalar](https://raw.githubusercontent.com/Betguin/warframe-monitor/main/warframe-monitor.user.js).
3. Confirme a instalação no Tampermonkey e abra o [Warframe Market](https://warframe.market/).
4. Abra o Warframe Monitor pelo ícone e configure seu webhook do Discord na engrenagem.

Se você já usa a versão anterior, substitua o código dentro do **mesmo script** do Tampermonkey para conservar seu armazenamento. Evite deixar duas cópias ativas.

## Recursos

- Itens comuns e Rivens velados, incluindo Companion Weapon.
- Rivens de armas específicas, Kuva Liches e Sisters of Parvos.
- Detecção da página e importação dos filtros da busca de contratos.
- Alertas para ofertas iguais ou inferiores ao limite, com vendedor, link e mensagem para copiar.
- Filtros de rank, atributos, rolagens, bônus elemental, efêmera e peculiaridade.
- Plataforma e crossplay lidos do próprio site ao salvar o monitor.
- Lista de monitores visível, configurações recolhidas e histórico para evitar repetições.

## Limitações da Alpha

Mantenha o navegador aberto e uma aba do Market carregada. A consulta é periódica, não em tempo real; suspensão de abas e limites da API podem atrasar alertas. Buscas amplas de contratos podem ter resultados limitados. Leilões sem preço de compra imediata não são tratados como ofertas de compra.

O webhook fica no armazenamento local do Tampermonkey. Não publique a URL do seu webhook em issues, capturas de tela ou arquivos do repositório.

Consulte o [guia de uso](GUIA.md) para detalhes de filtros, migração e execução. Projeto independente, sem afiliação oficial com Warframe Market ou Digital Extremes.
