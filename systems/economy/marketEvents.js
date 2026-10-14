// let activeEvent = null;

// /*
// Example event:
// {
//   name: "Gold Rush",
//   description: "Gold prices surge due to mining boom",
//   multiplier: {
//     ore_gold: 2.0
//   },
//   endsAt: timestamp
// }
// */

// const events = [
//     {
//         name: "⛏️ Mining Boom",
//         description: "All ore values increased due to industrial demand.",
//         multiplier: {
//             ore_iron: 1.5,
//             ore_gold: 1.4,
//             ore_mythril: 1.3
//         },
//         durationMs: 1000 * 60 * 10
//     },
//     {
//         name: "💎 Crystal Surge",
//         description: "Rare materials become extremely valuable.",
//         multiplier: {
//             diamond: 2.0,
//             quantum_shard: 2.5
//         },
//         durationMs: 1000 * 60 * 8
//     },
//     {
//         name: "📉 Market Crash",
//         description: "Economy instability reduces all prices.",
//         multiplier: {
//             ore_iron: 0.7,
//             ore_gold: 0.6,
//             ore_mythril: 0.5,
//             diamond: 0.6
//         },
//         durationMs: 1000 * 60 * 6
//     },
//     {
//         name: "⚡ Tech Frenzy",
//         description: "Quantum materials spike in demand.",
//         multiplier: {
//             quantum_shard: 3.0
//         },
//         durationMs: 1000 * 60 * 7
//     }
// ];

// function startEvent() {
//     const event = events[Math.floor(Math.random() * events.length)];

//     activeEvent = {
//         ...event,
//         endsAt: Date.now() + event.durationMs
//     };
// }

// function getEvent() {
//     if (!activeEvent) return null;

//     if (Date.now() > activeEvent.endsAt) {
//         activeEvent = null;
//         return null;
//     }

//     return activeEvent;
// }

// // auto event loop
// function startEventLoop() {
//     setInterval(() => {
//         if (!activeEvent) {
//             startEvent();
//         }
//     }, 1000 * 60 * 5); // try every 5 min
// }

// module.exports = {
//     getEvent,
//     startEvent,
//     startEventLoop
// };