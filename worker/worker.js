const puppeteer = require('puppeteer');
const admin = require('firebase-admin');
const { Octokit } = require('@octokit/rest');

// Initialize Firebase Admin SDK
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG || '{}');
admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig)
});

// Initialize GitHub API
const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN
});

const [owner, repo] = process.env.GITHUB_REPO.split('/');

async function getDeviceTokens() {
    console.log('📱 Fetching device tokens from GitHub Issues...');
    
    try {
        const { data: issues } = await octokit.rest.issues.listForRepo({
            owner,
            repo,
            labels: 'device-token',
            state: 'open'
        });
        
        const tokens = issues.map(issue => issue.body.trim()).filter(Boolean);
        console.log(`Found ${tokens.length} registered devices`);
        return tokens;
        
    } catch (error) {
        console.error('Error fetching tokens:', error.message);
        return [];
    }
}

async function getLatestOffer() {
    console.log('🕷️ Launching browser...');
    
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--single-process'
        ]
    });
    
    try {
        const page = await browser.newPageAsync();
        
        // Set realistic headers
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9,el;q=0.8',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        });
        
        console.log('🌐 Navigating to site...');
        await page.goto('https://www.lagonika.gr/', {
            waitUntil: 'networkidle0',
            timeout: 60000
        });
        
        // Wait for content to load (bypass Cloudflare)
        await page.waitForSelector('#tour-offerContainer', { timeout: 30000 });
        
        // Extract offer data
        const offerData = await page.evaluate(() => {
            const titleEl = document.querySelector('#tour-offerContainer h3');
            const linkEl = document.querySelector('#tour-offerContainer a.linkTag');
            
            return {
                title: titleEl?.innerText?.trim() || null,
                link: linkEl?.href || null
            };
        });
        
        // Make link absolute if relative
        if (offerData.link && offerData.link.startsWith('/')) {
            offerData.link = 'https://www.lagonika.gr' + offerData.link;
        }
        
        console.log('📦 offer:', offerData);
        return offerData;
        
    } finally {
        await browser.close();
    }
}

async function sendNotifications(tokens, offer) {
    if (!tokens.length || !offer.title || !offer.link) {
        console.log('❌ No tokens or offer data available');
        return;
    }
    
    console.log(`🔔 Sending notifications to ${tokens.length} devices...`);
    
    const messages = tokens.map(token => ({
        token: token,
        notification: {
            title: '🚀 Νέα Προσφορά!',
            body: offer.title,
        },
        webpush: {
            notification: {
                title: '🚀 Νέα Προσφορά!',
                body: offer.title,
                click_action: offer.link
            },
            fcmOptions: {
                link: offer.link
            }
        }
    }));
    
    try {
        // Send in batches of 500 (FCM limit)
        const batchSize = 5;
        let totalSent = 0;
        
        for (let i = 0; i < messages.length; i += batchSize) {
            const batch = messages.slice(i, i + batchSize);
            const response = await admin.messaging().sendAll(batch);
            
            console.log(`📊 Batch ${Math.floor(i/batchSize) + 1}: ${response.successCount}/${batch.length} sent`);
            totalSent += response.successCount;
            
            // Log failed tokens for cleanup
            response.responses.forEach((result, index) => {
                if (!result.success) {
                    console.log(`❌ Failed token: ${batch[index].token} - ${result.error?.message}`);
                }
            });
        }
        
        console.log(`✅ Total notifications sent: ${totalSent}`);
        
    } catch (error) {
        console.error('❌ Error sending notifications:', error.message);
    }
}

async function saveLastOffer(offer) {
    // Store last offer in repository file for comparison
    const content = Buffer.from(JSON.stringify(offer, null, 2)).toString('base64');
    
    try {
        // Try to get existing file
        let sha;
        try {
            const { data: fileData } = await octokit.rest.repos.getContent({
                owner,
                repo,
                path: 'last-offer.json'
            });
            sha = fileData.sha;
        } catch (error) {
            // File doesn't exist, that's okay
        }
        
        await octokit.rest.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: 'last-offer.json',
            message: `Update last offer: ${offer.title}`,
            content: content,
            sha: sha
        });
        
        console.log('💾 Saved offer to repository');
        
    } catch (error) {
        console.error('Error saving offer:', error.message);
    }
}

async function getLastOffer() {
    try {
        const { data: fileData } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: 'last-offer.json'
        });
        
        const content = Buffer.from(fileData.content, 'base64').toString();
        return JSON.parse(content);
        
    } catch (error) {
        console.log('No previous offer found');
        return null;
    }
}

// Main execution
(async () => {
    try {
        console.log('🚀 Starting worker...');
        
        // Get device tokens
        const tokens = await getDeviceTokens();
        
        if (tokens.length === 0) {
            console.log('📱 No device tokens registered yet');
            return;
        }
        
        // latest offer
        const currentOffer = await getLatestOffer();
        
        if (!currentOffer.title || !currentOffer.link) {
            console.log('❌ No offer found');
            return;
        }
        
        // Check if offer is new
        const lastOffer = await getLastOffer();
        
        if (lastOffer && lastOffer.title === currentOffer.title) {
            console.log('📋 Same offer as last time, no notifications sent');
            return;
        }
        
        // Send notifications for new offer
        await sendNotifications(tokens, currentOffer);
        
        // Save current offer
        await saveLastOffer(currentOffer);
        
        console.log('✅ completed successfully');
        
    } catch (error) {
        console.error('💥 Fatal error:', error);
        process.exit(1);
    }
})();