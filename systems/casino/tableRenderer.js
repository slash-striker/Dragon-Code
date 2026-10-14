let createCanvas;

function warnCanvasFallback(message) {
    if (process.env.DEBUG_CANVAS === '1' || process.env.DEBUG_CANVAS === 'true') {
        console.warn(message);
    }
}

try {
    ({ createCanvas } = require('@napi-rs/canvas'));
} catch (error) {
    warnCanvasFallback('Canvas support unavailable: casino table images will fall back to a placeholder PNG.');
}

const { AttachmentBuilder } = require('discord.js');
const { cardText } = require('./cards');
const { getUser } = require('../economy/userManager');

const FALLBACK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAF' +
    'r7MZAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJ0UkG' +
    'AAAAAAgIY0l5AAAAC0lEQVR4n2NgYAAAAAIAAeIhvAAAAABJRU5ErkJggg==',
    'base64'
);

const CARD_WIDTH = 112;
const CARD_HEIGHT = 154;
const CARD_SPACING = 130;

function renderCard(ctx, card, x, y, hidden = false, useHighTech = true) {
    if (useHighTech) {
        ctx.fillStyle = hidden ? '#27105a' : '#f4f7ff';
        ctx.strokeStyle = hidden ? '#ff38d1' : '#00e5ff';
        ctx.lineWidth = 4;

        ctx.beginPath();
        ctx.roundRect(x, y, CARD_WIDTH, CARD_HEIGHT, 12);
        ctx.fill();
        ctx.stroke();

        if (hidden) {
            ctx.fillStyle = '#00e5ff';
            ctx.font = 'bold 28px sans-serif';
            ctx.fillText('◈', x + 42, y + 88);
            return;
        }

        const red = card.suit === '♥' || card.suit === '♦';

        ctx.fillStyle = red ? '#ed365f' : '#101725';
        ctx.font = 'bold 25px sans-serif';
        ctx.fillText(cardText(card), x + 13, y + 37);

        ctx.font = 'bold 46px sans-serif';
        ctx.fillText(card.suit, x + 38, y + 103);
    } else {
        // Normal/basic card styling
        ctx.fillStyle = hidden ? '#2c3e50' : '#ffffff';
        ctx.strokeStyle = hidden ? '#34495e' : '#000000';
        ctx.lineWidth = 2;

        ctx.beginPath();
        ctx.roundRect(x, y, CARD_WIDTH, CARD_HEIGHT, 8);
        ctx.fill();
        ctx.stroke();

        if (hidden) {
            ctx.fillStyle = '#34495e';
            ctx.font = 'bold 24px sans-serif';
            ctx.fillText('?', x + 48, y + 88);
            return;
        }

        const red = card.suit === '♥' || card.suit === '♦';

        ctx.fillStyle = red ? '#e74c3c' : '#2c3e50';
        ctx.font = 'bold 22px sans-serif';
        ctx.fillText(cardText(card), x + 13, y + 37);

        ctx.font = 'bold 42px sans-serif';
        ctx.fillText(card.suit, x + 38, y + 103);
    }
}

function casinoTable({
    title,
    playerCards = [],
    dealerCards = [],
    dealerValue = null,
    playerValue = null,
    communityCards = [],
    status,
    filename = 'table.png',
    large = false,
    userId = null
}) {
    if (!createCanvas) {
        return new AttachmentBuilder(FALLBACK_PNG, { name: filename });
    }

    const isHoldem = large || communityCards.length > 0;
    const useHighTech = userId ? (getUser(userId)?.uiStyle !== 'normal') : true;

    // Bigger Hold'em table, much taller Blackjack table.
    const WIDTH = isHoldem ? 1500 : 900;
    const HEIGHT = isHoldem ? 850 : 700;

    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');

    if (useHighTech) {
        // High-tech styling
        const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
        gradient.addColorStop(0, '#050916');
        gradient.addColorStop(1, '#13052a');

        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, WIDTH, HEIGHT);

        // Subtle scanline layer keeps the table unmistakably cyber-tech without
        // affecting card readability.
        ctx.fillStyle = 'rgba(82, 255, 240, 0.055)';
        for (let y = 0; y < HEIGHT; y += 8) ctx.fillRect(0, y, WIDTH, 1);

        // Border
        ctx.strokeStyle = '#00d4ff';
        ctx.lineWidth = 3;
        ctx.strokeRect(18, 18, WIDTH - 36, HEIGHT - 36);
        ctx.strokeStyle = 'rgba(255, 56, 209, 0.7)';
        ctx.lineWidth = 1;
        ctx.strokeRect(25, 25, WIDTH - 50, HEIGHT - 50);

        // Title
        ctx.fillStyle = '#6fffe9';
        ctx.font = 'bold 30px sans-serif';
        ctx.fillText(title, 42, 60);

        ctx.fillStyle = '#a9b5d1';
        ctx.font = '18px sans-serif';
        ctx.fillText(status || '', 42, 91);
    } else {
        // Normal style - transparent background, no table
        // Leave canvas transparent (no fill)
    }

    //
    // BLACKJACK
    //

    if (!isHoldem) {

        if (dealerCards.length) {
            ctx.fillStyle = useHighTech ? '#ff8de6' : '#000000';
            ctx.font = 'bold 18px sans-serif';
            ctx.fillText(`DEALER: ${dealerValue ?? '?'}`, 42, useHighTech ? 165 : 30);

            dealerCards.forEach((card, i) => {
                renderCard(
                    ctx,
                    card.card || card,
                    42 + i * CARD_SPACING,
                    useHighTech ? 180 : 50,
                    card.hidden,
                    useHighTech
                );
            });
        }

        if (playerCards.length) {
            ctx.fillStyle = useHighTech ? '#6fffe9' : '#000000';
            ctx.font = 'bold 18px sans-serif';
            ctx.fillText(`YOUR CARDS: ${playerValue ?? '?'}`, 42, useHighTech ? 455 : 230);

            // Left-aligned blackjack hand
            playerCards.forEach((card, i) => {
                renderCard(
                    ctx,
                    card,
                    42 + i * CARD_SPACING,
                    useHighTech ? 470 : 250,
                    false,
                    useHighTech
                );
            });
        }


    //
    // HOLD'EM
    //
    } else {

        const LEFT = 50;

        // Opponents
        if (dealerCards.length) {
            if (useHighTech) {
                ctx.fillStyle = '#ff8de6';
                ctx.font = 'bold 22px sans-serif';
                ctx.fillText('DEALER / OPPONENTS', LEFT, 160);
            }

            dealerCards.forEach((card, i) => {
                renderCard(
                    ctx,
                    card.card || card,
                    LEFT + i * CARD_SPACING,
                    useHighTech ? 180 : 50,
                    card.hidden,
                    useHighTech
                );
            });
        }

        // Community Cards
        if (communityCards.length) {
            if (useHighTech) {
                ctx.fillStyle = '#ffdd76';
                ctx.font = 'bold 24px sans-serif';
                ctx.fillText('COMMUNITY CARDS', LEFT, 390);
            }

            communityCards.forEach((card, i) => {
                renderCard(
                    ctx,
                    card,
                    LEFT + i * CARD_SPACING,
                    useHighTech ? 410 : 200,
                    false,
                    useHighTech
                );
            });
        }

        // Player
        if (playerCards.length) {
            if (useHighTech) {
                ctx.fillStyle = '#6fffe9';
                ctx.font = 'bold 24px sans-serif';
                ctx.fillText('YOUR HAND', LEFT, 610);
            }

            playerCards.forEach((card, i) => {
                renderCard(
                    ctx,
                    card,
                    LEFT + i * CARD_SPACING,
                    useHighTech ? 630 : 350,
                    false,
                    useHighTech
                );
            });
        }
    }

    return new AttachmentBuilder(
        canvas.toBuffer('image/png'),
        {
            name: filename
        }
    );
}

module.exports = {
    casinoTable
};
