package com.example.data.api

import retrofit2.http.*

data class MobileLoginRequest(val email: String, val password: String, val tenantId: Long? = null, val deviceLabel: String? = null)
data class MobileUser(val id: Long, val name: String?, val role: String, val tenantId: Long, val branchIds: List<Long>, val subscriptionEndsAt: String, val mustChangePassword: Boolean = false)
data class MobileSessionResponse(val accessToken: String, val refreshToken: String, val expiresIn: Long, val user: MobileUser)
data class MobileMeResponse(val user: MobileUser)
data class MobileRefreshRequest(val refreshToken: String)
data class MobileChangePasswordRequest(val newPassword: String)

data class MobileReadingCycleBoundsDto(
    val key: String,
    val startAt: String,
    val endAt: String,
    val label: String,
    val asOf: String? = null
)
data class MobileSubscriberCycleReadingDto(
    val readingId: Long,
    val readingValue: String,
    val readingAt: String,
    val status: String
)
data class MobileSubscriberDto(
    val id: Long,
    val subscriberNo: String,
    val fullName: String,
    val phone: String,
    val address: String?,
    val branchId: Long,
    val lastReading: String?,
    val lastReadingAt: String?,
    val hasReadingInCurrentCycle: Boolean = false,
    val currentCycleReading: MobileSubscriberCycleReadingDto? = null
)
data class MobileSubscribersResponse(
    val items: List<MobileSubscriberDto>,
    val nextCursor: String?,
    val currentCycle: MobileReadingCycleBoundsDto? = null
)
data class MobileCycleSyncStatsResponse(
    val branchId: Long,
    val from: String,
    val to: String,
    val syncedReadingCount: Int
)
data class MobileReadingCycleConfigDto(
    val cycleType: String,
    val weeklyStartDay: Int,
    val monthlyStartDay: Int,
    val timezone: String
)
data class MobileReadingCycleResponse(
    val cycle: MobileReadingCycleConfigDto,
    val currentCycle: MobileReadingCycleBoundsDto
)


data class MobileReadingRequest(
    val clientOperationId: String,
    val branchId: Long,
    val subscriberId: Long,
    val readingValue: String,
    val readingAt: String,
    val captureMethod: String,
    val isReadingReset: Boolean,
    val fieldVerified: Boolean,
    val latitude: Double? = null,
    val longitude: Double? = null,
    val imageData: String? = null,
    val imageMime: String? = null,
    val notes: String? = null
)
data class MobileReadingResponse(val id: Long, val status: String, val consumptionKwh: String?, val replayed: Boolean)
data class MobileSyncEventRequest(
    val eventKey: String,
    val branchId: Long,
    val eventType: String,
    val status: String,
    val syncedCount: Int,
    val retryableCount: Int,
    val needsReviewCount: Int,
    val errorCode: String? = null,
    val errorMessage: String? = null,
    val appVersion: String? = null,
    val deviceLabel: String? = null,
    val occurredAt: String
)
data class MobileSyncEventResponse(val id: Long, val replayed: Boolean)

interface FieldReadingApi {
    @POST("api/mobile/v1/auth/login")
    suspend fun login(@Body request: MobileLoginRequest): MobileSessionResponse

    @POST("api/mobile/v1/auth/refresh")
    suspend fun refresh(@Body request: MobileRefreshRequest): MobileSessionResponse

    @POST("api/mobile/v1/auth/change-password")
    suspend fun changePassword(@Body request: MobileChangePasswordRequest)

    @POST("api/mobile/v1/auth/logout")
    suspend fun logout()

    @GET("api/mobile/v1/auth/me")
    suspend fun getProfile(): MobileMeResponse

    @GET("api/mobile/v1/subscribers")
    suspend fun getSubscribers(@Query("branchId") branchId: Long, @Query("limit") limit: Int = 100, @Query("cursor") cursor: String? = null): MobileSubscribersResponse

    @GET("api/mobile/v1/reading-cycle")
    suspend fun getReadingCycle(@Query("branchId") branchId: Long): MobileReadingCycleResponse

    @GET("api/mobile/v1/reading-cycle-sync-stats")
    suspend fun getCycleSyncStats(
        @Query("branchId") branchId: Long,
        @Query("from") from: String,
        @Query("to") to: String
    ): MobileCycleSyncStatsResponse

    @POST("api/mobile/v1/readings")
    suspend fun createReading(@Body request: MobileReadingRequest): MobileReadingResponse

    @POST("api/mobile/v1/sync-events")
    suspend fun createSyncEvent(@Body request: MobileSyncEventRequest): MobileSyncEventResponse
}
