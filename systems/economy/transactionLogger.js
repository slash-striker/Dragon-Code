const db = require('../../database');

// Initialize transactions table
function initTransactionsTable() {
    try {
        db.prepare(`
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                userId TEXT NOT NULL,
                type TEXT NOT NULL,
                amount INTEGER NOT NULL,
                description TEXT,
                timestamp INTEGER NOT NULL
            )
        `).run();

        // Create index for faster queries
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(userId)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp)`).run();
    } catch (e) {
        console.error('Error creating transactions table:', e);
    }
}

// Log a transaction
function logTransaction(userId, type, amount, description = '') {
    try {
        db.prepare(`
            INSERT INTO transactions (userId, type, amount, description, timestamp)
            VALUES (?, ?, ?, ?, ?)
        `).run(userId, type, amount, description, Date.now());

        // Keep only last 40 transactions per user (2 pages worth)
        const transactions = db.prepare(`
            SELECT id FROM transactions WHERE userId = ? ORDER BY timestamp DESC
        `).all(userId);

        if (transactions.length > 40) {
            const toDelete = transactions.slice(40).map(t => t.id);
            const placeholders = toDelete.map(() => '?').join(',');
            db.prepare(`DELETE FROM transactions WHERE id IN (${placeholders})`).run(...toDelete);
        }
    } catch (e) {
        console.error('Error logging transaction:', e);
    }
}

// Get recent transactions for a user
function getTransactions(userId, limit = 20) {
    try {
        return db.prepare(`
            SELECT type, amount, description, timestamp
            FROM transactions
            WHERE userId = ?
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(userId, limit);
    } catch (e) {
        console.error('Error getting transactions:', e);
        return [];
    }
}

// Get total spent by user (negative amounts)
function getTotalSpent(userId) {
    try {
        const result = db.prepare(`
            SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) as total
            FROM transactions
            WHERE userId = ?
        `).get(userId);
        return result.total || 0;
    } catch (e) {
        console.error('Error getting total spent:', e);
        return 0;
    }
}

module.exports = {
    initTransactionsTable,
    logTransaction,
    getTransactions,
    getTotalSpent
};
