
require('dotenv').config();
const bodyParser = require('body-parser');

const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors')
const app = express();
const port = process.env.SERVER_PORT;

const cron = require('node-cron');
const timescale = 30000;
app.use(bodyParser.json());
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ADMIN_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);


const allowedOrigins = [
    'http://localhost:3000',  // Example port 1
    'http://localhost:3001'   // Example port 2
  ];
  
  const corsOptions = {
    origin: function(origin, callback) {
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    }
  };

  app.use(cors(corsOptions));
// app.use(cors({
//   origin: 'http://localhost:3000', 
//   origin: 'http://localhost:3001'// Allow requests from this origin
// }));

cron.schedule('0 * * * * *', async () => {
    console.log('Cron job started');
  
    try {
      // Call the stored function to increment the 'coins' column by 10,000 for all rows
      const { data, error } = await supabase
        .rpc('increment_coins', { amount: 10 })
        
        ;
      console.log("DATA " + data);
      console.log("ERROR : " + error);  
      if (error) {
        console.error('Error calling function:', error.message);
      } else {
        console.log('Coins column updated successfully for all rows');
      }
    } catch (err) {
      console.error('Error in cron job:', err.message);
    }
  });












let bets = [];
let jackpotTotal = 0;
let roundActive = false;
let roundEndTime = null;
let winner = null;

const pickWinner = async (bets) => {
    let totalWeight = bets.reduce((acc, bet) => acc + bet.betAmount, 0);
    let random = Math.random() * totalWeight;

    for (let bet of bets) {
        if (random < bet.betAmount) {
            // Bet found, now pick this user as the winner
            winner = bet;
            await awardJackpotToWinner(bet.userId);
            return bet;
        }
        random -= bet.betAmount;
    }
};

// Function to award jackpot to the winner
const awardJackpotToWinner = async (userId) => {
    try {
        // Fetch the user with their current coin balance
        const { data, error } = await supabase
            .from('gamblers')
            .select('id, coins')
            .eq('id', userId)
            .single();

        if (error || !data) {
            console.log('Error fetching user or user does not exist:', error ? error.message : 'No data');
            return;
        }

        // Calculate new coin balance
        const newCoinBalance = data.coins + jackpotTotal;

        // Update the user's coin balance in the database
        const { error: updateError } = await supabase
            .from('gamblers')
            .update({ coins: newCoinBalance })
            .eq('id', userId);

        if (updateError) {
            console.log('Error updating coin balance:', updateError.message);
            return;
        }

        console.log('Jackpot awarded to user ID:', userId, 'New balance:', newCoinBalance);
    } catch (error) {
        console.error('Error awarding jackpot:', error.message);
    }
};

// Function to start a new round
const startRound = () => {
    winner = null;
    jackpotTotal = 0;
    bets = [];
    
    if (roundActive) {
        console.log('Round already active');
        return;
    }

    roundActive = true;
    roundEndTime = Date.now() + timescale; // 30 seconds from now
    
    console.log('ROUND STARTED : ' + new Date(Date.now()).toISOString() + '   END TIME : ' + new Date(roundEndTime).toISOString());

    // Schedule the round to end and pick a winner after 30 seconds
    setTimeout(async () => {
        if (bets.length > 0) {
            await pickWinner(bets);
            console.log('Round ended. Winner:', winner, 'Jackpot Total:', jackpotTotal);
        } else {
            console.log('Round ended with no bets placed.' + new Date(Date.now()).toISOString());
        }
        // Reset for the next round
        roundActive = false;
        roundEndTime = null;
    }, timescale); // 30 seconds
};

// Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
    // Automatically start a new round every 60 seconds
    startRound(); // Start the first round immediately
    setInterval(startRound, timescale + 10000); // 60 seconds interval
});

// Check user ID and deduct coins
const checkUserIdAndDeductCoins = async (userId, betAmount) => {
    try {
        // Fetch the user with their current coin balance
        const { data, error } = await supabase
            .from('gamblers')
            .select('id, coins')
            .eq('id', userId)
            .single();

        if (error || !data) {
            console.log('Error checking user ID existence or user does not exist:', error ? error.message : 'No data');
            return { exists: false, hasEnoughCoins: false };
        }

        // Check if the user has enough coins
        if (data.coins < betAmount) {
            return { exists: true, hasEnoughCoins: false };
        }

        // Deduct the bet amount from the user's coins
        const newCoinBalance = data.coins - betAmount;

        // Update the user's coin balance in the database
        const { error: updateError } = await supabase
            .from('gamblers')
            .update({ coins: newCoinBalance })
            .eq('id', userId);

        if (updateError) {
            console.log('Error updating coin balance:', updateError.message);
            return { exists: true, hasEnoughCoins: false };
        }

        return { exists: true, hasEnoughCoins: true };
    } catch (error) {
        console.error('Error checking user ID existence or updating coin balance:', error.message);
        return { exists: false, hasEnoughCoins: false };
    }
};

// Endpoint to place a bet
app.post('/place-bet', async (req, res) => {
    if (!roundActive) {
        return res.status(400).json({ message: 'No active round' });
    }

    const { userId, betAmount } = req.body;

    if (betAmount !== 5 && betAmount !== 10 && betAmount !== 20) {
        return res.status(400).json({ message: 'Invalid bet amount. Must be 5 , 10 or 20' });
    }
    if (bets.find(bet => bet.userId == userId)) {
        return res.status(400).json({ message: 'User already in pot' });
    }
    // Check if user exists, has enough coins, and deduct coins
    const { exists, hasEnoughCoins } = await checkUserIdAndDeductCoins(userId, betAmount);

    if (!exists) {
        return res.status(400).json({ message: 'User does not exist' });
    }

    if (!hasEnoughCoins) {
        return res.status(400).json({ message: 'Insufficient coins to place the bet' });
    }

    // If the user exists and has enough coins, place the bet
    bets.push({ userId, betAmount });
    jackpotTotal += betAmount;
    console.log("Bet received " + betAmount + " ID " + userId);
    console.log("Jackpot current:", jackpotTotal);
    res.json({ message: 'Bet placed successfully', jackpotTotal });
});

// Endpoint to get round status
app.get('/round-status', (req, res) => {
   // console.log("ROUND STATUS CALLED");
    res.json({
        winner,
        bets,
        roundActive,
        jackpotTotal,
        roundEndTime: roundEndTime ? new Date(roundEndTime).getTime() : null,
    });
});