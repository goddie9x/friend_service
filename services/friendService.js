const Friend = require('../models/friend');
const { FRIENDSHIP } = require('../constants/friend');
const { TargetAlreadyExistException, TargetNotExistException, BadRequestException } = require('../utils/exceptions/commonExceptions');
const { sendCreateNotificationKafkaMessage } = require('../utils/kafka');
const { kafkaProducer } = require('../kafka/producer');
const { TYPE: NOTIFICATION_TYPE } = require('../utils/constants/notification');
const { GEN_FRIEND_REQUEST_LIST_ROUTE } = require('../utils/constants/clientRoute');
class FriendService {
    constructor() {
        this.getPaginatedResults = this.getPaginatedResults.bind(this);
        this.getFriendRequestsWithPagination = this.getFriendRequestsWithPagination.bind(this);
        this.getFriendListWithPagination = this.getFriendListWithPagination.bind(this);
    }

    async getPaginatedResults(query, page, limit) {
        const skip = (page - 1) * limit;
        const getResultsPromise = Friend.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));
        const getTotalDocumentsPromise = Friend.countDocuments(query);
        const [results, totalDocuments] = await Promise.all([getResultsPromise, getTotalDocumentsPromise]);

        return {
            results,
            totalDocuments,
            totalPages: Math.ceil(totalDocuments / limit)
        };
    }

    async getFriendRequestsWithPagination(payloads) {
        const { id, page = 1, limit = 10 } = payloads;

        const query = {
            receiver: id,
            isAccepted: false
        };

        const { results: friendRequests, totalDocuments: totalRequests, totalPages } =
            await this.getPaginatedResults(query, page, limit);

        return {
            page,
            limit,
            totalRequests,
            totalPages,
            friendRequests
        };
    }

    async getFriendListWithPagination(payloads) {
        const { id, page = 1, limit = 10 } = payloads;

        const query = {
            $or: [
                { sender: id },
                { receiver: id }
            ],
            isAccepted: true
        };

        const { results: friendList, totalDocuments: totalFriends, totalPages } =
            await this.getPaginatedResults(query, page, limit);

        return {
            page,
            limit,
            totalFriends,
            totalPages,
            friendList
        };
    }

    async addFriend(payloads) {
        const { currentUser, receiverId, friendshipType } = payloads;
        const senderId = currentUser.userId;

        if (senderId === receiverId) {
            throw new BadRequestException('Sender and receiver cannot be the same person.');
        }

        const existingFriend = await Friend.findOne({
            $or: [{
                sender: senderId, receiver: receiverId,
            },
            {
                receiver: receiverId, receiver: senderId
            }]
        });

        if (existingFriend) {
            throw new TargetAlreadyExistException('A Friend already exists between these users.');
        }
        const friendship = new Friend({
            sender: senderId,
            receiver: receiverId,
            friendshipType: friendshipType || FRIENDSHIP.FRIEND
        });

        await friendship.save();
        sendCreateNotificationKafkaMessage(
            kafkaProducer,
            {
                target: friendship.sender,
                type: NOTIFICATION_TYPE.FRIEND_REQUEST,
                content: `New friend request <user>${friendship.sender}</user>`,
                href: GEN_FRIEND_REQUEST_LIST_ROUTE(friendship.sender)
            }
        );
        return friendship;
    }
    async acceptRequest(payloads) {
        const { id, currentUser } = payloads;

        const friendRequest = await Friend.findOne({
            _id: id,
            receiver: currentUser.userId,
            isAccepted: false
        });

        if (!friendRequest) {
            throw new TargetNotExistException('Friend request not found or already accepted.');
        }

        friendRequest.isAccepted = true;
        friendRequest.acceptedAt = Date.now();
        await friendRequest.save();

        sendCreateNotificationKafkaMessage(
            kafkaProducer,
            {
                target: friendRequest.receiver,
                type: NOTIFICATION_TYPE.FRIEND_REQUEST,
                content: `<user>${friendRequest.receiver}</user> accepted your friend request`,
                href: GEN_FRIEND_REQUEST_LIST_ROUTE(friendRequest.receiver)
            }
        );
        return friendRequest;
    }
    async refuseRequest(payloads) {
        const { id, currentUser } = payloads;
        const friendRequest = await Friend.findOneAndDelete({
            _id: id,
            receiver: currentUser.userId,
            isAccepted: false
        });

        if (!friendRequest) {
            throw new TargetNotExistException('Friend request not found or already accepted.');
        }
    }
    async getFriendshipInfo(payloads) {
        const { id, currentUser } = payloads;

        const friendship = await Friend.findOne({
            _id: id,
            receiver: currentUser.userId
        });

        if (!friendship) {
            throw new TargetNotExistException('Friendship not found.');
        }

        return friendship;
    }
}

module.exports = new FriendService();