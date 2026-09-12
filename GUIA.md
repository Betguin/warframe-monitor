# Warframe Monitor — Alpha (3.3.1)

Nova identidade visual: painel escuro azulado, detalhes em verde-água, lista de monitores compacta e o ícone fornecido incorporado ao botão e ao cabeçalho. O Tampermonkey baixa o ícone do repositório via @resource e guarda uma cópia local. Não há Base64 no código. A numeração técnica continua 3.3.1 para manter a sequência de atualização; a interface identifica esta fase como Alpha.

O campo **Seu preço máximo (plat)** define a regra “igual ou mais barato”. Ao digitar 100, o botão mostra **Alertar por 100 plat ou menos**. O Discord exibe o preço real da oferta e **Seu limite: 100 plat**. Isso não garante que a oferta seja a mais barata de todo o mercado: são notificadas as ofertas retornadas que atendem aos filtros e ao limite.

A interface agora acompanha a página: ao abrir um item, ele já aparece selecionado; ao navegar em Contratos, o painel muda para Riven, Lich ou Sister e importa a busca aplicada. Isso também funciona na navegação sem recarregar o site.

A tela principal mostra o item/arma, o limite de preço, o botão de ativar e **Monitores salvos** já expandidos. **Filtros** fica recolhido. As configurações ficam escondidas e podem ser abertas pela **engrenagem ⚙** no cabeçalho. O webhook e o status estão nessa área. Plataforma e crossplay são lidos dos controles do próprio site ao salvar, sem seletores duplicados na extensão. Se ainda não houver webhook válido salvo, Configurações aparece automaticamente; depois de salvar, fica escondida.

## Instalação

1. Abra o painel do Tampermonkey e edite o script antigo **WF Market — Notificador de Preço Baixo (Discord)** (ou **Warframe Monitor**, se já atualizou).
2. Substitua todo o conteúdo pelo arquivo `warframe-monitor.user.js` e salve com **Ctrl+S**.
3. Recarregue as abas do Warframe Market. Não mantenha uma segunda cópia do script antigo ativa.

Ao editar o mesmo script, o webhook e os monitores antigos de itens comuns são migrados automaticamente. Instalar como outro script pode criar um armazenamento separado; nesse caso, configure os monitores e o webhook novamente. A primeira consulta após a migração pode notificar ofertas já vistas pela versão antiga.

## Configurar um alerta

Abra o botão com o ícone do **Warframe Monitor** no canto inferior esquerdo.

- **Item comum ou Riven velado:** entre na página do item no site. O notificador detecta o nome; basta definir o preço e ativar. Para itens com rank, o filtro opcional de rank fica recolhido.
- **Riven de arma específica:** faça a busca em Contratos no site. O painel importa a arma e os filtros; você pode ajustar atributos, negativo, polaridade, MR, rolagens e rank em Filtros.
- **Kuva Lich / Sister:** faça a busca no site. O painel importa a arma e permite ajustar elemento, bônus (25–60%), efêmera e peculiaridade. Para uma efêmera específica, escolha o elemento dela e “Com efêmera”.

Não há buscador de itens no notificador. Na página inicial ou sem uma busca de contrato aplicada, ele orienta a abrir a página correspondente. Rivens velados com parênteses no endereço, incluindo Companion Weapon, são reconhecidos como itens comuns. Os catálogos são obtidos da API, com cache de 24 horas.

Defina o limite em platinas. Para alterar o status do vendedor, expanda **Configurações**. Plataforma e crossplay seguem a seleção do site no momento de salvar, inclusive quando ela muda sem alterar a URL. Cada monitor conserva essa seleção para as consultas seguintes; para alterá-la em um monitor existente, selecione no site, edite o monitor e salve novamente. Se os controles do site ainda não carregaram, o script usa a última seleção lida nesta página ou a plataforma do subdomínio (PC no domínio principal), sem crossplay quando não foi possível detectar essa opção. O padrão de vendedor é **somente IN-GAME**, e de preço é **venda direta**, exceto quando a busca importada especifica outro modo de preço. Expanda **Monitores salvos** e depois **Detalhes e ações** para editar, pausar ou remover cada um. Salvar novamente a mesma busca atualiza seu limite em vez de criar outra igual.

Faça uma busca na seção **Contratos** do site e clique em **Search**: o painel importa automaticamente a arma e os filtros da URL. **Usar página atual** permite voltar à busca aberta depois de editar outro monitor ou tentar novamente em caso de erro. A importação exige uma arma específica. Confira os filtros importados antes de salvar. O status visual do vendedor no site não faz parte da URL: selecione esse status em Configurações. A seleção de arma/filtros ainda não aplicada pelo botão Search não é importada; a categoria do seletor do site, quando disponível, já altera o painel. Ao navegar para outra página, o formulário muda; salve o monitor antes de sair para conservar sua configuração.

## Alertas e preços

- O alerta dispara quando a oferta tem preço **menor ou igual** ao limite e atende aos filtros e ao status escolhido.
- Cada nova oferta elegível gera um alerta. Na primeira consulta, isso inclui as ofertas já existentes: um limite alto pode gerar várias mensagens.
- A mesma oferta no mesmo preço não dispara de novo. Uma mudança de preço que continue dentro do limite pode gerar novo alerta. Pausar/reativar mantém esse histórico.
- **Venda direta + compra imediata de leilão** considera o `buyout_price`. Leilões sem compra imediata são excluídos. O lance inicial e o lance atual não são considerados preços de compra.
- A mensagem inclui vendedor, preço, dados da oferta, texto de whisper e link. Em contratos, o link leva ao anúncio específico.
- O script apenas envia notificações ao webhook configurado. Não compra, não dá lances e não envia whispers no jogo.

A média exibida é a média de até cinco ofertas mais baratas retornadas que atendem aos filtros, inclusive vendedores offline. Não é uma avaliação do valor de mercado de um Riven. Os valores dos atributos no alerta são os valores anunciados, no rank anunciado; não são normalizados para rank 8.

## Execução e limitações

- Mantenha o navegador aberto, o computador acordado e uma aba do Warframe Market carregada. Aba suspensa pelo navegador pode atrasar as consultas. Não é um serviço que roda com o computador desligado.
- Cada monitor volta à fila após aproximadamente dois minutos. Há pelo menos 6,5 segundos entre buscas de contratos; muitos monitores ou alertas aumentam o tempo da volta completa.
- Em navegadores com Web Locks, uma única aba do mesmo domínio executa os monitores e outra assume quando ela fecha. Use um único domínio do Market: a trava não é compartilhada entre `warframe.market` e subdomínios de plataforma. Em navegadores sem Web Locks, mantenha uma única aba.
- Falhas de rede, timeout e limites HTTP 429/509 provocam novas tentativas com espera progressiva. O erro aparece no monitor; uma falha não apaga sua configuração.
- A busca de contratos pode retornar um conjunto limitado de anúncios. O painel avisa quando a quantidade sugere esse limite. Use filtros específicos; não há garantia de capturar todos os anúncios existentes ou uma oferta que apareça e desapareça entre duas consultas.
- A API pública v2 fornece os itens e os catálogos. A busca de contratos usa a v1, observada no funcionamento atual do site. Mudanças nessa API podem exigir atualização do script.

## Verificação realizada

As consultas públicas de itens, Rivens, Liches e Sisters foram verificadas com respostas reais da API. Os testes locais cobrem filtros, preços de compra, status, migração, deduplicação e a interface. O envio ao Discord foi simulado nos testes: use **Testar webhook** para confirmar o seu canal. Não foi instalado ou executado no Tampermonkey do usuário durante a preparação.

Referências: [documentação oficial da API](https://docs.warframe.market/docs/api/overview/), [regras de uso da API](https://docs.warframe.market/docs/rules/overview/), [busca de contratos](https://warframe.market/auctions).
