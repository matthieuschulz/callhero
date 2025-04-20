// @ts-check
/// <reference path="../types/chrome.d.ts" />
/// <reference path="../types/index.js" />

/** @type {Intl.DateTimeFormatOptions} */
const timeFormat = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
}


chrome.runtime.onMessage.addListener(function (messageUnTyped, sender, sendResponse) {
    const message = /** @type {ExtensionMessage} */ (messageUnTyped)
    console.log(message.type)

    if (message.type === "new_meeting_started") {
        // Saving current tab id, to download transcript when this tab is closed
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            const tabId = tabs[0].id
            chrome.storage.local.set({ meetingTabId: tabId }, function () {
                console.log("Meeting tab id saved")
            })
        })
    }

    if (message.type === "meeting_ended") {
        processLastMeeting().finally(() => {
            // Invalidate tab id since transcript is downloaded, prevents double downloading of transcript from tab closed event listener
            clearTabIdAndApplyUpdate()
        })
    }

    if (message.type === "download_transcript_at_index") {
        if ((typeof message.index === "number") && (message.index >= 0)) {
            // Download the requested item
            downloadTranscript(message.index, false)
                .then(() => {
                    /** @type {ExtensionResponse} */
                    const response = { success: true }
                    sendResponse(response)
                })
                .catch((error) => {
                    /** @type {ExtensionResponse} */
                    const response = { success: false, message: error }
                    sendResponse(response)
                })
        }
        else {
            /** @type {ExtensionResponse} */
            const response = { success: false, message: "Invalid index" }
            sendResponse(response)
        }
    }

    if (message.type === "retry_webhook_at_index") {
        if ((typeof message.index === "number") && (message.index >= 0)) {
            // Handle webhook retry
            postTranscriptToWebhook(message.index)
                .then(() => {
                    /** @type {ExtensionResponse} */
                    const response = { success: true }
                    sendResponse(response)
                })
                .catch(error => {
                    console.error("Webhook retry failed:", error)
                    /** @type {ExtensionResponse} */
                    const response = { success: false, message: error }
                    sendResponse(response)
                })
        }
        else {
            /** @type {ExtensionResponse} */
            const response = { success: false, message: "Invalid index" }
            sendResponse(response)
        }
    }

    if (message.type === "recover_last_meeting") {
        recoverLastMeeting().then((message) => {
            /** @type {ExtensionResponse} */
            const response = { success: true, message: message }
            sendResponse(response)
        })
            .catch((error) => {
                /** @type {ExtensionResponse} */
                const response = { success: false, message: error }
                sendResponse(response)
            })
    }
    return true
})

// Download last meeting if meeting tab is closed
chrome.tabs.onRemoved.addListener(function (tabId) {
    chrome.storage.local.get(["meetingTabId"], function (resultLocalUntyped) {
        const resultLocal = /** @type {ResultLocal} */ (resultLocalUntyped)

        if (tabId === resultLocal.meetingTabId) {
            console.log("Successfully intercepted tab close")

            processLastMeeting().finally(() => {
                // Clearing meetingTabId to prevent misfires of onRemoved until next meeting actually starts
                clearTabIdAndApplyUpdate()
            })
        }
    })
})

// Listen for extension updates
chrome.runtime.onUpdateAvailable.addListener(() => {
    // Check if there is an active meeting
    chrome.storage.local.get(["meetingTabId"], function (resultUntyped) {
        const result = /** @type {ResultLocal} */ (resultUntyped)

        if (result.meetingTabId) {
            // There is an active meeting, defer the update
            chrome.storage.local.set({ isDeferredUpdatedAvailable: true }, function () {
                console.log("Deferred update flag set")
            })
        } else {
            // No active meeting, apply the update immediately. Meeting tab id is invalidated only post meeting operations are done, so no race conditions.
            console.log("No active meeting, applying update immediately")
            chrome.runtime.reload()
        }
    })
})

// Download transcripts, post webhook if URL is enabled and available
// Fails if transcript is empty or webhook request fails or if no meetings in storage
function processLastMeeting() {
    return new Promise((resolve, reject) => {
        pickupLastMeetingFromStorage()
            .then(() => {
                chrome.storage.local.get(["meetings"], async function (resultLocalUntyped) {
                    const resultLocal = /** @type {ResultLocal} */ (resultLocalUntyped)
                    chrome.storage.sync.get(["webhookUrl", "autoPostWebhookAfterMeeting"], function (resultSyncUntyped) {
                        const resultSync = /** @type {ResultSync} */ (resultSyncUntyped)

                        // Create an array of promises to execute in parallel
                        /** @type {Promise<any>[]} */
                        const promises = []

                        // Meeting index to download and post webhook
                        const lastIndex = resultLocal.meetings.length - 1

                        // Promise to download transcript
                        promises.push(
                            downloadTranscript(
                                lastIndex,
                                // Just for anonymous analytics
                                resultSync.webhookUrl && resultSync.autoPostWebhookAfterMeeting ? true : false
                            )
                        )

                        // Promise to post webhook if enabled
                        if (resultSync.autoPostWebhookAfterMeeting && resultSync.webhookUrl) {
                            promises.push(postTranscriptToWebhook(lastIndex))
                        }

                        // Execute all promises in parallel
                        Promise.all(promises)
                            .then(() => {
                                resolve("Meeting processing and download/webhook posting complete")
                            })
                            .catch(error => {
                                console.error("Operation failed:", error)
                                reject(error)
                            })
                    })
                })
            })
            .catch((error) => {
                reject(error)
            })
    })
}

// Process transcript and chat messages of the meeting that just ended from storage, format them into strings, and save as a new entry in meetings (keeping last 10)
function pickupLastMeetingFromStorage() {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get([
            "meetingTitle",
            "meetingStartTimestamp",
            "transcript",
            "chatMessages",
        ], function (resultUntyped) {
            const result = /** @type {ResultLocal} */ (resultUntyped)

            if (result.meetingStartTimestamp) {
                if ((result.transcript.length > 0) || (result.chatMessages.length > 0)) {
                    // Create new transcript entry
                    /** @type {Meeting} */
                    const newMeetingEntry = {
                        meetingTitle: result.meetingTitle,
                        meetingStartTimestamp: result.meetingStartTimestamp,
                        meetingEndTimestamp: new Date().toISOString(),
                        transcript: result.transcript,
                        chatMessages: result.chatMessages,
                        webhookPostStatus: "new"
                    }

                    // Get existing recent meetings and add the new meeting
                    chrome.storage.local.get(["meetings"], function (resultLocalUntyped) {
                        const resultLocal = /** @type {ResultLocal} */ (resultLocalUntyped)
                        let meetings = resultLocal.meetings || []
                        meetings.push(newMeetingEntry)

                        // Keep only last 10 transcripts
                        if (meetings.length > 10) {
                            meetings = meetings.slice(-10)
                        }

                        // Save updated recent transcripts
                        chrome.storage.local.set({ meetings: meetings }, function () {
                            console.log("Last meeting picked up")
                            resolve("Last meeting picked up")
                        })
                    })
                }
                else {
                    reject("Empty transcript and empty chatMessages")
                }
            }
            else {
                reject("No meetings found. May be attend one?")
            }
        })
    })
}



/**
 * @param {number} index
 * @param {boolean} isWebhookEnabled
 */
function downloadTranscript(index, isWebhookEnabled) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(["meetings"], async function (resultLocalUntyped) {
            const resultLocal = /** @type {ResultLocal} */ (resultLocalUntyped)

            if (resultLocal.meetings && resultLocal.meetings[index]) {
                const meeting = resultLocal.meetings[index]

                // Sanitise meeting title to prevent invalid file name errors
                // https://stackoverflow.com/a/78675894
                const invalidFilenameRegex = /[:?"*<>|~/\\\u{1}-\u{1f}\u{7f}\u{80}-\u{9f}\p{Cf}\p{Cn}]|^[.\u{0}\p{Zl}\p{Zp}\p{Zs}]|[.\u{0}\p{Zl}\p{Zp}\p{Zs}]$|^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?=\.|$)/gui
                let sanitisedMeetingTitle = "Google Meet call"
                if (meeting.meetingTitle) {
                    sanitisedMeetingTitle = meeting.meetingTitle.replaceAll(invalidFilenameRegex, "_")
                }
                else if (meeting.title) {
                    sanitisedMeetingTitle = meeting.title.replaceAll(invalidFilenameRegex, "_")
                }

                // Format timestamp for human-readable filename and sanitise to prevent invalid filenames
                const timestamp = new Date(meeting.meetingStartTimestamp)
                const formattedTimestamp = timestamp.toLocaleString("default", timeFormat).replace(/[\/:]/g, "-")

                const fileName = `Transcript-${sanitisedMeetingTitle} at ${formattedTimestamp}.txt`


                // Format transcript, analytics, and chatMessages content
                let content = getTranscriptString(meeting.transcript)

                // Generate analytics (AI‑powered if possible)
                const analyticsSection = await getAIAnalyticsString(meeting.transcript)
                content += `\n\n---------------\nCALL ANALYTICS & COACHING\n---------------\n\n`
                content += analyticsSection

                // Add chat messages after analytics
                content += `\n\n---------------\nCHAT MESSAGES\n---------------\n\n`
                content += getChatMessagesString(meeting.chatMessages)

                // Add branding
                content += "\n\n---------------\n"
                content += "Transcript saved using WindsurfOnsiteDemo Chrome extension (https://chromewebstore.google.com/detail/ciepnfnceimjehngolkijpnbappkkiag)"
                content += "\n---------------"

                const blob = new Blob([content], { type: "text/plain" })

                // Read the blob as a data URL
                const reader = new FileReader()

                // Read the blob
                reader.readAsDataURL(blob)

                // Download as text file, once blob is read
                reader.onload = function (event) {
                    if (event.target?.result) {
                        const dataUrl = event.target.result

                        // Create a download with Chrome Download API
                        chrome.downloads.download({
                            // @ts-ignore
                            url: dataUrl,
                            filename: fileName,
                            conflictAction: "uniquify"
                        }).then(() => {
                            console.log("Transcript downloaded")
                            resolve("Transcript downloaded successfully")

                            // Increment anonymous transcript generated count to a Google sheet
                            fetch(`https://script.google.com/macros/s/AKfycbw4wRFjJcIoC5uDfscITSjNtUj83JVrBXKn44u9Cs0BoKNgyvt0A5hmG-xsJnlhfVu--g/exec?version=${chrome.runtime.getManifest().version}&isWebhookEnabled=${isWebhookEnabled}`, {
                                mode: "no-cors"
                            })
                        }).catch((err) => {
                            console.error(err)
                            chrome.downloads.download({
                                // @ts-ignore
                                url: dataUrl,
                                filename: "Transcript.txt",
                                conflictAction: "uniquify"
                            })
                            console.log("Invalid file name. Transcript downloaded to root of Downloads folder with simple file name.")
                            resolve("Transcript downloaded successfully with default file name")

                            // Logs anonymous errors to a Google sheet for swift debugging   
                            fetch(`https://script.google.com/macros/s/AKfycbw4wRFjJcIoC5uDfscITSjNtUj83JVrBXKn44u9Cs0BoKNgyvt0A5hmG-xsJnlhfVu--g/exec?version=${chrome.runtime.getManifest().version}&code=009&error=${encodeURIComponent(err)}`, { mode: "no-cors" })
                            // Increment anonymous transcript generated count to a Google sheet
                            fetch(`https://script.google.com/macros/s/AKfycbzUk-q3N8_BWjwE90g9HXs5im1pYFriydKi1m9FoxEmMrWhK8afrHSmYnwYcw6AkH14eg/exec?version=${chrome.runtime.getManifest().version}&isWebhookEnabled=${isWebhookEnabled}`, {
                                mode: "no-cors"
                            })
                        })
                    }
                    else {
                        reject(new Error("Failed to read blob"))
                    }
                }
            }
            else {
                reject(new Error("Meeting at specified index not found"))
            }
        })
    })
}

/**
 * @param {number} index
 */
function postTranscriptToWebhook(index) {
    return new Promise((resolve, reject) => {
        // Get webhook URL and meetings
        chrome.storage.local.get(["meetings"], function (resultLocalUntyped) {
            const resultLocal = /** @type {ResultLocal} */ (resultLocalUntyped)
            chrome.storage.sync.get(["webhookUrl", "webhookBodyType"], function (resultSyncUntyped) {
                const resultSync = /** @type {ResultSync} */ (resultSyncUntyped)

                if (resultSync.webhookUrl) {
                    if (resultLocal.meetings || resultLocal.meetings[index]) {
                        const meeting = resultLocal.meetings[index]

                        /** @type {WebhookBody} */
                        let webhookData
                        if (resultSync.webhookBodyType === "advanced") {
                            webhookData = {
                                meetingTitle: meeting.meetingTitle || meeting.title || "",
                                meetingStartTimestamp: new Date(meeting.meetingStartTimestamp).toISOString(),
                                meetingEndTimestamp: new Date(meeting.meetingEndTimestamp).toISOString(),
                                transcript: meeting.transcript,
                                chatMessages: meeting.chatMessages
                            }
                        }
                        else {
                            webhookData = {
                                meetingTitle: meeting.meetingTitle || meeting.title || "",
                                meetingStartTimestamp: new Date(meeting.meetingStartTimestamp).toLocaleString("default", timeFormat).toUpperCase(),
                                meetingEndTimestamp: new Date(meeting.meetingEndTimestamp).toLocaleString("default", timeFormat).toUpperCase(),
                                transcript: getTranscriptString(meeting.transcript),
                                chatMessages: getChatMessagesString(meeting.chatMessages)
                            }
                        }

                        // Post to webhook
                        fetch(resultSync.webhookUrl, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify(webhookData)
                        }).then(response => {
                            if (!response.ok) {
                                throw new Error(`Webhook request failed: ${response.status} ${response.statusText}`)
                            }
                        }).then(() => {
                            // Update success status
                            resultLocal.meetings[index].webhookPostStatus = "successful"
                            chrome.storage.local.set({ meetings: resultLocal.meetings }, function () {
                                resolve("Webhook posted successfully")
                            })
                        }).catch(error => {
                            console.error(error)
                            // Update failure status
                            resultLocal.meetings[index].webhookPostStatus = "failed"
                            chrome.storage.local.set({ meetings: resultLocal.meetings }, function () {
                                // Create notification and open webhooks page
                                chrome.notifications.create({
                                    type: "basic",
                                    iconUrl: "icon.png",
                                    title: "Could not post webhook!",
                                    message: "Click to view status and retry. Check console for more details."
                                }, function (notificationId) {
                                    // Handle notification click
                                    chrome.notifications.onClicked.addListener(function (clickedNotificationId) {
                                        if (clickedNotificationId === notificationId) {
                                            chrome.tabs.create({ url: "meetings.html" })
                                        }
                                    })
                                })

                                reject(error)
                            })
                        })
                    }
                    else {
                        reject(new Error("Meeting at specified index not found"))
                    }
                }
                else {
                    reject(new Error("No webhook URL configured"))
                }
            })
        })
    })
}


/**
 * Format transcript entries into string
 * @param {TranscriptBlock[]} transcript
 */
function getTranscriptString(transcript) {
    let transcriptString = ""
    if (transcript.length > 0) {
        transcript.forEach(transcriptBlock => {
            transcriptString += `${transcriptBlock.personName} (${new Date(transcriptBlock.timestamp).toLocaleString("default", timeFormat).toUpperCase()})\n`
            transcriptString += transcriptBlock.transcriptText
            transcriptString += "\n\n"
        })
        return transcriptString
    }
    return transcriptString
}


/**
 * Format chat messages into string
 * @param {ChatMessage[]} chatMessages
 */
function getChatMessagesString(chatMessages) {
    let chatMessagesString = ""
    if (chatMessages.length > 0) {
        chatMessages.forEach(chatMessage => {
            chatMessagesString += `${chatMessage.personName} (${new Date(chatMessage.timestamp).toLocaleString("default", timeFormat).toUpperCase()})\n`
            chatMessagesString += chatMessage.chatMessageText
            chatMessagesString += "\n\n"
        })
    }
    return chatMessagesString
}

function clearTabIdAndApplyUpdate() {
    chrome.storage.local.set({ meetingTabId: null }, function () {
        console.log("Meeting tab id cleared for next meeting")

        // Check if there's a deferred update
        chrome.storage.local.get(["isDeferredUpdatedAvailable"], function (resultLocalUntyped) {
            const resultLocal = /** @type {ResultLocal} */ (resultLocalUntyped)

            if (resultLocal.isDeferredUpdatedAvailable) {
                console.log("Applying deferred update")
                chrome.storage.local.set({ isDeferredUpdatedAvailable: false }, function () {
                    chrome.runtime.reload()
                })
            }
        })
    })
}

function recoverLastMeeting() {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(["meetings", "meetingStartTimestamp"], function (resultLocalUntyped) {
            const resultLocal = /** @type {ResultLocal} */ (resultLocalUntyped)
            // Check if user ever attended a meeting
            if (resultLocal.meetingStartTimestamp) {
                const meetingToDownload = resultLocal.meetings[resultLocal.meetings.length - 1]

                // Last meeting was not processed for some reason. Need to recover that data, process and download it.
                if ((!meetingToDownload) || (resultLocal.meetingStartTimestamp !== meetingToDownload.meetingStartTimestamp)) {
                    processLastMeeting().then(() => {
                        resolve("Recovered last meeting to the best possible extent")
                    }).catch((error) => {
                        // Fails if transcript is empty or webhook request fails or user never attended any meetings
                        reject(error)
                    })
                }
                else {
                    resolve("No recovery needed")
                }
            }
            else {
                reject("No meetings found. May be attend one?")
            }
        })
    })
}

/**
 * Generate analytics and coaching insights for the call transcript
 * @param {TranscriptBlock[]} transcript
 * @returns {string}
 */
function getRuleBasedAnalytics(transcript) {
    // Early return if transcript empty
    if (!transcript || transcript.length === 0) {
        return "No transcript data available to generate analytics.";
    }

    /** @type {Record<string, {wordCount:number, questionCount:number, fillerCount:number}>} */
    const speakerStats = {}

    const fillerWords = ["um", "uh", "you know", "like", "hmm", "erm", "ah", "so"]

    transcript.forEach(block => {
        const speaker = block.personName || "Unknown"
        if (!speakerStats[speaker]) {
            speakerStats[speaker] = { wordCount: 0, questionCount: 0, fillerCount: 0 }
        }

        const words = block.transcriptText.split(/\s+/).filter(Boolean)
        speakerStats[speaker].wordCount += words.length

        // Count questions (naively by '?')
        speakerStats[speaker].questionCount += (block.transcriptText.match(/\?/g) || []).length

        // Count filler words (case‑insensitive)
        const lower = block.transcriptText.toLowerCase()
        fillerWords.forEach(fw => {
            const regex = new RegExp(`\\b${fw}\\b`, "g")
            speakerStats[speaker].fillerCount += (lower.match(regex) || []).length
        })
    })

    // Compute totals & talk ratios
    const totalWords = Object.values(speakerStats).reduce((acc, s) => acc + s.wordCount, 0) || 1

    let analyticsString = "PARTICIPANTS ANALYSIS\n\n"

    Object.entries(speakerStats).forEach(([speaker, stats]) => {
        const ratio = ((stats.wordCount / totalWords) * 100).toFixed(1)
        analyticsString += `${speaker}:\n  Talk Ratio: ${ratio}%\n  Questions Asked: ${stats.questionCount}\n  Filler Words: ${stats.fillerCount}\n\n`
    })

    // Identify dominant speaker (highest wordCount)
    const dominantSpeaker = Object.entries(speakerStats).sort((a, b) => b[1].wordCount - a[1].wordCount)[0][0]
    const dominantRatio = ((speakerStats[dominantSpeaker].wordCount / totalWords) * 100)

    analyticsString += "COACHING INSIGHTS\n\n"

    // Suggest balanced talk time
    if (dominantRatio > 60) {
        analyticsString += `- ${dominantSpeaker} spoke ${dominantRatio.toFixed(1)}% of the time. Consider encouraging more two‑way dialogue.\n`
    } else {
        analyticsString += "- Good balance of talk time among participants.\n"
    }

    // Suggest asking more questions for each speaker
    Object.entries(speakerStats).forEach(([speaker, stats]) => {
        if (stats.questionCount < 3) {
            analyticsString += `- ${speaker} asked only ${stats.questionCount} question(s). Try incorporating more open‑ended questions.\n`
        }
    })

    // Suggest reducing filler words
    Object.entries(speakerStats).forEach(([speaker, stats]) => {
        if (stats.fillerCount > 5) {
            analyticsString += `- ${speaker} used ${stats.fillerCount} filler words. Practice concise messaging.\n`
        }
    })

    return analyticsString
}

// === AI‑powered analytics ===
/**
 * Attempts to generate deep coaching insights using OpenAI. Falls back to rule‑based analytics if
 * API key not configured or request fails.
 * @param {TranscriptBlock[]} transcript
 * @returns {Promise<string>} analytics string
 */
async function getAIAnalyticsString(transcript) {
    // Import helper to read API key (duplicated small util to avoid circular deps)
    const apiKey = await new Promise((resolve) => {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(["OPENAI_API_KEY"], (result) => {
                resolve(result.OPENAI_API_KEY || null)
            })
        } else {
            resolve(null)
        }
    })

    if (!apiKey) {
        console.warn("OpenAI API key not found. Using rule‑based analytics.")
        return getRuleBasedAnalytics(transcript)
    }

    // Prepare prompt with transcript (truncate to keep within token limits)
    const maxChars = 6000 // ~ 1.5k tokens; adjust as needed
    let transcriptText = ""
    transcript.forEach(block => {
        transcriptText += `${block.personName}: ${block.transcriptText}\n`
    })
    if (transcriptText.length > maxChars) {
        transcriptText = transcriptText.slice(-maxChars) // take last part of conversation
    }

    const prompt = `You are a world‑class sales coach. Analyze the following sales call transcript and produce:
1. Participant talk ratios and key stats (questions asked, filler words observed).
2. 5–8 bullet‑point highlights of what the rep did well.
3. 5–8 bullet‑point actionable areas for improvement.
4. Overall sentiment and next‑step recommendation.
Output must be plain text, markdown‑style bullets, no JSON. Keep it concise and helpful.\n\nTRANSCRIPT:\n\n${transcriptText}`

    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                temperature: 0.4,
                messages: [
                    { role: "system", content: "You are an expert sales coach." },
                    { role: "user", content: prompt }
                ]
            })
        })
        if (!response.ok) throw new Error(`OpenAI error ${response.status}`)
        const data = await response.json()
        const aiText = data.choices?.[0]?.message?.content?.trim()
        return aiText || getRuleBasedAnalytics(transcript)
    } catch (err) {
        console.error("Failed to get AI analytics:", err)
        return getRuleBasedAnalytics(transcript)
    }
}