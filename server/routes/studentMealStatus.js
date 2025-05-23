const express = require('express');
const router = express.Router();
// const StudentMealStatus = require('../models/StudentMealStatus'); // Comment out or remove
const MealSelection = require('../models/MealSelection'); // Import MealSelection
const auth = require('../middleware/auth');
const crypto = require('crypto');
const mongoose = require('mongoose');

// Helper function to generate QR code
function generateQRCode(studentId, hostelId, meal, date) {
  const data = `${studentId}-${hostelId}-${meal}-${date}-${Date.now()}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Get meal status for a specific date
router.get('/date/:date', auth, async (req, res) => {
  try {
    const { date } = req.params;
    const { hostelId } = req.query;

    if (!hostelId) {
      return res.status(400).json({ error: 'Hostel ID is required' });
    }
    
    // Convert hostelId string to ObjectId if it's not already
    let hostelObjectId;
    try {
        hostelObjectId = new mongoose.Types.ObjectId(hostelId);
    } catch (err) {
        console.error("Invalid Hostel ID format:", hostelId);
        return res.status(400).json({ error: 'Invalid Hostel ID format' });
    }


    // Fetch from MealSelection collection
    const mealSelections = await MealSelection.find({
      hostelId: hostelObjectId, // Use ObjectId for query
      date
    }).select('studentName studentEmail meals'); // Select necessary fields

    // Transform data to match frontend's MealStatus interface
    const mealStatus = mealSelections.map(selection => ({
      studentName: selection.studentName,
      studentEmail: selection.studentEmail,
      meals: {
        breakfast: {
          opted: selection.meals.breakfast.selected, // Map selected to opted
          qrCode: selection.meals.breakfast.qrCode,
          used: selection.meals.breakfast.used,
          usedAt: selection.meals.breakfast.usedAt
        },
        lunch: {
          opted: selection.meals.lunch.selected, // Map selected to opted
          qrCode: selection.meals.lunch.qrCode,
          used: selection.meals.lunch.used,
          usedAt: selection.meals.lunch.usedAt
        },
        dinner: {
          opted: selection.meals.dinner.selected, // Map selected to opted
          qrCode: selection.meals.dinner.qrCode,
          used: selection.meals.dinner.used,
          usedAt: selection.meals.dinner.usedAt
        }
      }
    }));
    
    console.log(`[Server] Found ${mealStatus.length} meal statuses for date: ${date}, hostel: ${hostelId}`);
    res.json(mealStatus);

  } catch (error) {
    console.error('[Server] Error fetching meal status:', error);
    res.status(500).json({ error: 'Error fetching meal status' });
  }
});

// Update meal status for a student
router.post('/update', auth, async (req, res) => {
  try {
    const { studentId, hostelId, date, meal, opted, studentName, studentEmail } = req.body;

    if (!studentId || !hostelId || !date || !meal || !studentName || !studentEmail) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate meal type
    const validMeals = ['breakfast', 'lunch', 'dinner'];
    if (!validMeals.includes(meal)) {
      return res.status(400).json({ error: 'Invalid meal type' });
    }

    let mealStatus = await MealSelection.findOne({ // Changed to MealSelection
      studentId,
      hostelId,
      date
    });

    if (!mealStatus) {
        // If not found, potentially create a new one, but this logic might
        // be handled elsewhere (e.g., when student makes initial selection).
        // For now, let's return an error or handle as appropriate.
        // Creating a default entry here might not be correct for MealSelection.
        console.warn(`[Server] MealSelection not found for student ${studentId} on ${date}. Update request ignored.`);
        // Or create a new MealSelection if that's the desired behavior
        // mealStatus = new MealSelection({ ... initial data ... });
        return res.status(404).json({ error: 'Meal selection record not found for this student and date.' });
    }

    // Update the specific meal - Use 'selected' field for MealSelection
    mealStatus.meals[meal] = {
      ...mealStatus.meals[meal], // Preserve existing fields like used, usedAt
      selected: opted, // Use 'selected' field
      qrCode: opted ? generateQRCode(studentId, hostelId, meal, date) : null,
      // Reset usage status if opting out? Or handle this differently?
      // used: false, 
      // usedAt: null 
    };
    
    // Add submittedAt timestamp if needed by MealSelection schema
    if (mealStatus.meals[meal].submittedAt !== undefined) {
        mealStatus.meals[meal].submittedAt = new Date();
    }

    await mealStatus.save();

    res.json({
      message: 'Meal selection updated successfully',
      qrCode: mealStatus.meals[meal].qrCode
    });
  } catch (error) {
    console.error('[Server] Error updating meal selection:', error); // Updated log message
    res.status(500).json({ error: 'Error updating meal selection' }); // Updated error message
  }
});


// Mark QR code as used
router.post('/use-qr', auth, async (req, res) => {
  try {
    const { studentId, qrCode, meal } = req.body;
    const today = new Date().toISOString().split('T')[0]; // Use current date

    // Validate meal type
    const validMeals = ['breakfast', 'lunch', 'dinner'];
    if (!validMeals.includes(meal)) {
      return res.status(400).json({ error: 'Invalid meal type' });
    }

    // Find the meal selection record using MealSelection model
    const mealSelection = await MealSelection.findOne({
      studentId,
      date: today, // Assuming QR codes are only valid for the current day
      [`meals.${meal}.qrCode`]: qrCode,
      [`meals.${meal}.used`]: false, // Check if not already used
      [`meals.${meal}.selected`]: true // Check if the meal was actually selected
    });

    if (!mealSelection) {
      // Log more details for debugging
      console.log(`[Server] QR Use attempt failed: studentId=${studentId}, qrCode=${qrCode}, meal=${meal}, date=${today}`);
      const checkExisting = await MealSelection.findOne({ studentId, date: today });
      if (checkExisting) {
          console.log(`[Server] Found record for student/date, but QR/meal/status mismatch:`, {
              qrMatch: checkExisting.meals[meal]?.qrCode === qrCode,
              usedStatus: checkExisting.meals[meal]?.used,
              selectedStatus: checkExisting.meals[meal]?.selected
          });
      } else {
          console.log(`[Server] No MealSelection record found for student ${studentId} on date ${today}`);
      }
      return res.status(404).json({ error: 'Invalid, already used, or expired QR code' });
    }

    // Mark the specific meal as used
    mealSelection.meals[meal].used = true;
    mealSelection.meals[meal].usedAt = new Date();
    await mealSelection.save();

    console.log(`[Server] QR Code ${qrCode} for student ${studentId}, meal ${meal} marked as used.`);
    res.json({ message: 'QR code marked as used successfully' });
  } catch (error) {
    console.error('[Server] Error marking QR code as used:', error);
    res.status(500).json({ error: 'Error marking QR code as used' });
  }
});

// Get meal analytics for a specific date
router.get('/analytics/:date', auth, async (req, res) => {
  try {
    const { date } = req.params;
    const { hostelId } = req.query;

    if (!hostelId) {
      return res.status(400).json({ error: 'Hostel ID is required' });
    }

    // Convert hostelId string to ObjectId
    let hostelObjectId;
    try {
      hostelObjectId = new mongoose.Types.ObjectId(hostelId);
    } catch (err) {
      console.error("Invalid Hostel ID format:", hostelId);
      return res.status(400).json({ error: 'Invalid Hostel ID format' });
    }

    // Get all meal selections for the date
    const mealSelections = await MealSelection.find({
      hostelId: hostelObjectId,
      date: date
    });

    // Calculate analytics
    const analytics = {
      breakfast: mealSelections.filter(ms => ms.meals.breakfast.selected).length,
      lunch: mealSelections.filter(ms => ms.meals.lunch.selected).length,
      dinner: mealSelections.filter(ms => ms.meals.dinner.selected).length,
      totalStudents: mealSelections.length,
      studentStatuses: mealSelections.map(ms => ({
        studentId: ms.studentId,
        studentName: ms.studentName,
        breakfast: ms.meals.breakfast.selected,
        lunch: ms.meals.lunch.selected,
        dinner: ms.meals.dinner.selected
      }))
    };

    console.log(`[Server] Analytics for date ${date}, hostel ${hostelId}:`, {
      ...analytics,
      studentCount: analytics.studentStatuses.length
    });
    res.json(analytics);

  } catch (error) {
    console.error('[Server] Error fetching meal analytics:', error);
    res.status(500).json({ error: 'Error fetching meal analytics' });
  }
});

// Bulk update meal statuses
router.post('/update-bulk', auth, async (req, res) => {
  try {
    const { hostelId, date, studentStatuses } = req.body;

    if (!hostelId || !date || !Array.isArray(studentStatuses)) {
      return res.status(400).json({ error: 'Missing or invalid required fields' });
    }

    // Convert hostelId string to ObjectId
    let hostelObjectId;
    try {
      hostelObjectId = new mongoose.Types.ObjectId(hostelId);
    } catch (err) {
      console.error("Invalid Hostel ID format:", hostelId);
      return res.status(400).json({ error: 'Invalid Hostel ID format' });
    }

    // Process each student's meal status
    const updatePromises = studentStatuses.map(async (status) => {
      try {
        const studentId = new mongoose.Types.ObjectId(status.studentId);
        
        // Find or create meal selection
        let mealSelection = await MealSelection.findOne({
          studentId,
          hostelId: hostelObjectId,
          date
        });

        if (!mealSelection) {
          // If no record exists, skip this student
          console.warn(`No meal selection found for student ${status.studentId} on ${date}`);
          return;
        }

        // Update meal selections
        if (status.meals) {
          if (status.meals.breakfast) {
            mealSelection.meals.breakfast.selected = status.meals.breakfast.selected;
            if (status.meals.breakfast.selected) {
              mealSelection.meals.breakfast.qrCode = generateQRCode(studentId.toString(), hostelId, 'breakfast', date);
            }
          }
          if (status.meals.lunch) {
            mealSelection.meals.lunch.selected = status.meals.lunch.selected;
            if (status.meals.lunch.selected) {
              mealSelection.meals.lunch.qrCode = generateQRCode(studentId.toString(), hostelId, 'lunch', date);
            }
          }
          if (status.meals.dinner) {
            mealSelection.meals.dinner.selected = status.meals.dinner.selected;
            if (status.meals.dinner.selected) {
              mealSelection.meals.dinner.qrCode = generateQRCode(studentId.toString(), hostelId, 'dinner', date);
            }
          }
        }

        await mealSelection.save();
      } catch (error) {
        console.error(`Error updating meal status for student ${status.studentId}:`, error);
      }
    });

    await Promise.all(updatePromises);

    res.json({ message: 'Meal statuses updated successfully' });
  } catch (error) {
    console.error('[Server] Error in bulk update:', error);
    res.status(500).json({ error: 'Error updating meal statuses' });
  }
});

module.exports = router; 