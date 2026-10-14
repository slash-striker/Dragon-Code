const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function makeDeck() { return SUITS.flatMap(suit => RANKS.map(rank => ({ rank, suit }))); }
function shuffle(deck) {
    const copy = [...deck];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}
function cardText(card) { return `${card.rank}${card.suit}`; }
function blackjackValue(cards) {
    let total = 0; let aces = 0;
    for (const card of cards) {
        if (card.rank === 'A') { total += 11; aces++; }
        else if (['K', 'Q', 'J'].includes(card.rank)) total += 10;
        else total += Number(card.rank);
    }
    while (total > 21 && aces--) total -= 10;
    return total;
}
function isBlackjack(cards) { return cards.length === 2 && blackjackValue(cards) === 21; }

function combinations(items, size) {
    if (size === 0) return [[]];
    if (items.length < size) return [];
    const [first, ...rest] = items;
    return combinations(rest, size - 1).map(group => [first, ...group]).concat(combinations(rest, size));
}
function rank5(cards) {
    const values = cards.map(c => '23456789TJQKA'.indexOf(c.rank) + 2).sort((a, b) => b - a);
    const counts = [...new Set(values)].map(value => [value, values.filter(v => v === value).length]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const flush = new Set(cards.map(c => c.suit)).size === 1;
    const unique = [...new Set(values)].sort((a, b) => b - a);
    const wheel = unique.join(',') === '14,5,4,3,2';
    const straightHigh = unique.length === 5 && (unique[0] - unique[4] === 4 || wheel) ? (wheel ? 5 : unique[0]) : 0;
    if (flush && straightHigh) return [8, straightHigh];
    if (counts[0][1] === 4) return [7, counts[0][0], counts[1][0]];
    if (counts[0][1] === 3 && counts[1][1] === 2) return [6, counts[0][0], counts[1][0]];
    if (flush) return [5, ...values];
    if (straightHigh) return [4, straightHigh];
    if (counts[0][1] === 3) return [3, counts[0][0], ...counts.slice(1).map(x => x[0])];
    if (counts[0][1] === 2 && counts[1][1] === 2) return [2, counts[0][0], counts[1][0], counts[2][0]];
    if (counts[0][1] === 2) return [1, counts[0][0], ...counts.slice(1).map(x => x[0])];
    return [0, ...values];
}
function compareRanks(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); return 0; }
function holdemRank(cards) { return combinations(cards, 5).map(rank5).sort(compareRanks).pop(); }

module.exports = { makeDeck, shuffle, cardText, blackjackValue, isBlackjack, holdemRank, compareRanks };
