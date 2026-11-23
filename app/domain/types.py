"""Domain enums shared by the database models, adapters and domain logic."""

from enum import StrEnum


class ConversationState(StrEnum):
    AI_ACTIVE = "AI_ACTIVE"
    HANDOFF_PENDING = "HANDOFF_PENDING"
    HANDOFF_ACTIVE = "HANDOFF_ACTIVE"


class ChannelKind(StrEnum):
    INSTAGRAM = "instagram"
    JIVO = "jivo"
    TIDIO = "tidio"


class MessageSender(StrEnum):
    CLIENT = "client"
    AI = "ai"
    OPERATOR = "operator"
    SYSTEM = "system"


class HandoffTrigger(StrEnum):
    HUMAN_REQUESTED_TWICE = "human_requested_twice"
    HARSH_WORDS = "harsh_words"
    LOW_CONFIDENCE = "low_confidence"


class HandoffStatus(StrEnum):
    PENDING = "pending"
    ACTIVE = "active"
    CLOSED = "closed"
    NO_OPERATOR = "no_operator"


class OrderStatus(StrEnum):
    """Normalized order statuses. Each CRM adapter maps its own statuses to these."""

    AWAITING_PAYMENT = "awaiting_payment"
    PAID = "paid"
    PAYMENT_FAILED = "payment_failed"
    IN_PROGRESS = "in_progress"
    SHIPPED = "shipped"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    REFUNDED = "refunded"


FINISHED_ORDER_STATUSES = frozenset(
    {OrderStatus.COMPLETED, OrderStatus.CANCELLED, OrderStatus.REFUNDED}
)


class Role(StrEnum):
    ADMIN = "admin"
    OPERATOR = "operator"
    URGENT_MANAGER = "urgent_manager"


class CommunicationType(StrEnum):
    PHONE_CALL = "phone_call"
    WHATSAPP_TEXT = "whatsapp_text"


class MemoryKind(StrEnum):
    MESSAGE = "message"
    SUMMARY = "summary"
    FACT = "fact"


class RestrictionLevel(StrEnum):
    MEDIUM = "medium"
    HIGH = "high"
    STRICT = "strict"


class TopicCategory(StrEnum):
    """Topic of one client message, as the fast-tier classifier reports it."""

    PRODUCTS_ORDERS = "products_orders"
    BUSINESS_RELATED = "business_related"
    SMALL_TALK = "small_talk"
    OFF_TOPIC = "off_topic"
