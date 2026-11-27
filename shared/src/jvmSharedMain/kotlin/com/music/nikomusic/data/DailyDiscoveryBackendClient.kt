package com.music.nikomusic.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Client for Niko Music's server-only `POST /api/ai/recommend` endpoint.
 *
 * Strictly zero API keys are ever shipped to or held by the Android app: all
 * AI model credentials live exclusively on the backend server.
 */
class DailyDiscoveryBackendClient(
    private val timeoutSeconds: Long = 10L,
) {
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    sealed interface Result {
        data class Success(val response: AIRecommendResponse) : Result
        data object Disabled : Result
        data object RateLimited : Result
        data class NetworkError(val message: String) : Result
        data class HttpError(val code: Int, val message: String) : Result
    }

    suspend fun recommend(
        baseUrl: String,
        request: AIRecommendRequest,
    ): Result = withContext(Dispatchers.IO) {
        val cleanBase = baseUrl.trim().trimEnd('/')
        if (cleanBase.isEmpty()) return@withContext Result.Disabled

        val payload = json.encodeToString(AIRecommendRequest.serializer(), request)
            .toRequestBody(JSON_MEDIA_TYPE)
        val httpReq = Request.Builder()
            .url("$cleanBase/api/ai/recommend")
            .header("Content-Type", "application/json")
            .post(payload)
            .build()

        try {
            val call = Http.client.newCall(httpReq)
            call.timeout().timeout(timeoutSeconds, TimeUnit.SECONDS)
            call.execute().use { resp ->
                if (resp.code == 429) {
                    return@withContext Result.RateLimited
                }
                if (!resp.isSuccessful) {
                    return@withContext Result.HttpError(resp.code, "HTTP ${resp.code}")
                }
                val raw = resp.body.string()
                val decoded = runCatching {
                    json.decodeFromString(AIRecommendResponse.serializer(), raw)
                }.getOrElse { parseErr ->
                    DebugLog.w(TAG, "DailyDiscovery backend JSON decode error: ${parseErr.message}")
                    return@withContext Result.HttpError(resp.code, "Invalid AI response")
                }
                if (!decoded.enabled) {
                    Result.Disabled
                } else {
                    Result.Success(decoded)
                }
            }
        } catch (e: IOException) {
            DebugLog.d(TAG, "DailyDiscovery backend network unavailable: ${e.message}")
            Result.NetworkError(e.message ?: "Offline")
        } catch (e: Exception) {
            DebugLog.w(TAG, "DailyDiscovery backend error: ${e.message}")
            Result.HttpError(0, e.message ?: "Request failed")
        }
    }

    private companion object {
        const val TAG = "DailyDiscoveryAI"
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
